import { join } from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Context, Deferred, Effect, Exit, FileSystem, Layer, RcMap, Scope } from "effect";

import { ChannelRepository, type ChannelRepositoryError } from "./channel-repository.ts";
import { AppConfig } from "./config.ts";
import { createSessionSink } from "./discord/session-sink.ts";
import { createPiChannelSession, type ScopedPiChannelSession } from "./pi/channel-session.ts";
import { WORKSPACE_CWD } from "./pi/workspace.ts";
import { loadChannelState, type ChannelState } from "./channel-state.ts";
import {
  makeChannelRuntime,
  type ChannelRuntime,
  type CreateSessionParams,
  ChannelRuntimeOperationError,
  type ChannelRuntimeError,
} from "./channel-runtime.ts";
import { LoadedResources } from "./resources.ts";
import { PiContext } from "./pi/context.ts";

export type {
  ActivationParams,
  ChannelRuntimeError,
  CompactResult,
  CompactionParams,
  CreateSessionParams,
  DiscardResult,
} from "./channel-runtime.ts";

export interface ChannelSessionsShape {
  readonly get: (
    channelId: string,
  ) => Effect.Effect<ChannelRuntime, ChannelRuntimeError, Scope.Scope>;
}

export type SessionKeepAlive = {
  release: Effect.Effect<void, never, never>;
};

export type SessionKeepAliveFactory = () => Effect.Effect<SessionKeepAlive, never, Scope.Scope>;

const makeChannelSessions = (): Effect.Effect<
  ChannelSessionsShape,
  never,
  AppConfig | ChannelRepository | FileSystem.FileSystem | LoadedResources | PiContext | Scope.Scope
> => {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const repository = yield* ChannelRepository;
    const fs = yield* FileSystem.FileSystem;
    const resources = yield* LoadedResources;
    const piContext = yield* PiContext;

    const channelStorageDirectory = (channelId: string) =>
      join(config.storageDirectory, "channel", channelId);
    const workspaceDir = (channelId: string) =>
      join(channelStorageDirectory(channelId), "workspace");
    const sessionsDir = (channelId: string) => join(channelStorageDirectory(channelId), "sessions");

    const loadSessionManager = (
      channelId: string,
      activeSession?: string,
    ): Effect.Effect<SessionManager, ChannelRuntimeError> => {
      const dir = sessionsDir(channelId);
      return Effect.gen(function* () {
        yield* fs
          .makeDirectory(dir, { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ChannelRuntimeOperationError({ channelId, operation: "storage", cause }),
            ),
          );

        if (activeSession === undefined) {
          return SessionManager.create(WORKSPACE_CWD, dir);
        }

        return yield* Effect.try({
          try: () => SessionManager.open(join(dir, activeSession), dir, WORKSPACE_CWD),
          catch: (cause) =>
            new ChannelRuntimeOperationError({ channelId, operation: "storage", cause }),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              `Failed to resume session for channel ${channelId} from ${activeSession}. Starting a new session.`,
              error,
            ),
          ),
          Effect.catch(() => Effect.succeed(SessionManager.create(WORKSPACE_CWD, dir))),
        );
      });
    };

    const createPiSession = (
      input: CreateSessionParams,
      channel: ChannelState,
      makeKeepAlive: SessionKeepAliveFactory,
    ): Effect.Effect<
      { pi: ScopedPiChannelSession; sessionManager: SessionManager },
      ChannelRuntimeError
    > =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(workspaceDir(input.channel.id), { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new ChannelRuntimeOperationError({
                channelId: input.channel.id,
                operation: "storage",
                cause,
              }),
          ),
        );
        const sessionManager = yield* loadSessionManager(input.channel.id, channel.activeSession);
        const sink = createSessionSink(input.channel, config);

        const pi = yield* createPiChannelSession({
          channel: input.channel,
          getChannelSettings: () => channel.settings,
          hostWorkspaceDir: workspaceDir(input.channel.id),
          promptContext: input.promptContext,
          sessionManager,
          sink,
          makeKeepAlive,
        }).pipe(
          Effect.provideService(AppConfig, config),
          Effect.provideService(LoadedResources, resources),
          Effect.provideService(PiContext, piContext),
          Effect.mapError(
            (cause) =>
              new ChannelRuntimeOperationError({
                channelId: input.channel.id,
                operation: "session",
                cause,
              }),
          ),
        );

        return { pi, sessionManager };
      });

    const runtimesDeferred =
      yield* Deferred.make<RcMap.RcMap<string, ChannelRuntime, ChannelRepositoryError>>();

    const makeKeepAlive = (channelId: string): Effect.Effect<SessionKeepAlive> =>
      Effect.gen(function* () {
        const runtimes = yield* Deferred.await(runtimesDeferred);
        const keepAliveScope = yield* Scope.make();
        yield* Effect.forkIn(keepAliveScope)(
          RcMap.get(runtimes, channelId).pipe(Scope.provide(keepAliveScope)),
        );
        return {
          release: Scope.close(keepAliveScope, Exit.void),
        };
      });

    const runtimes = yield* RcMap.make({
      lookup: (channelId: string) =>
        Effect.gen(function* () {
          const state = yield* loadChannelState(channelId, repository);
          return yield* makeChannelRuntime({
            channelId,
            createPiSession,
            state,
            makeKeepAlive: () => makeKeepAlive(channelId),
          });
        }),
      idleTimeToLive: config.channelIdleTimeoutMs,
    });
    yield* Deferred.complete(runtimesDeferred, Effect.succeed(runtimes));

    return {
      get: (channelId: string) => RcMap.get(runtimes, channelId),
    };
  });
};

export class ChannelSessions extends Context.Service<ChannelSessions, ChannelSessionsShape>()(
  "bubblebuddy/ChannelSessions",
) {
  static readonly layer = Layer.effect(ChannelSessions, makeChannelSessions());
}
