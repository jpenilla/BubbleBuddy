import { join } from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Context, Effect, FileSystem, Layer, Scope, Semaphore } from "effect";

import { ChannelRepository } from "./channel-repository.ts";
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
  type ChannelRuntimeEntry,
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
  readonly get: (channelId: string) => Effect.Effect<ChannelRuntime, ChannelRuntimeError>;
}

const makeChannelSessions = (): Effect.Effect<
  ChannelSessionsShape,
  never,
  AppConfig | ChannelRepository | FileSystem.FileSystem | LoadedResources | PiContext | Scope.Scope
> => {
  const runtimes = new Map<string, ChannelRuntimeEntry>();
  const runtimeLock = Semaphore.makeUnsafe(1);

  return Effect.acquireRelease(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const repository = yield* ChannelRepository;
      const fs = yield* FileSystem.FileSystem;
      const resources = yield* LoadedResources;
      const piContext = yield* PiContext;

      const channelStorageDirectory = (channelId: string) =>
        join(config.storageDirectory, "channel", channelId);
      const workspaceDir = (channelId: string) =>
        join(channelStorageDirectory(channelId), "workspace");
      const sessionsDir = (channelId: string) =>
        join(channelStorageDirectory(channelId), "sessions");

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
          const sink = createSessionSink(input.channel, config, channel);

          const pi = yield* createPiChannelSession({
            channel: input.channel,
            getChannelSettings: () => channel.settings,
            hostWorkspaceDir: workspaceDir(input.channel.id),
            promptContext: input.promptContext,
            sessionManager,
            sink,
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

      const get = (channelId: string): Effect.Effect<ChannelRuntime, ChannelRuntimeError> =>
        runtimeLock.withPermit(
          Effect.gen(function* () {
            const existing = runtimes.get(channelId);
            if (existing !== undefined) {
              yield* existing.touch();
              return existing;
            }

            const state = yield* loadChannelState(channelId, repository);
            const runtime = yield* makeChannelRuntime({
              channelId,
              createPiSession,
              idleTimeoutMs: config.channelIdleTimeoutMs,
              state,
            });
            runtimes.set(channelId, runtime);
            return runtime;
          }),
        );

      return { get };
    }),
    () =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Shutdown requested. Shutting down channel sessions.");
        yield* Effect.gen(function* () {
          yield* Effect.logInfo("Channel session shutdown started.");
          const closeEffects = [...runtimes.values()].map((runtime) => runtime.shutdown());
          yield* Effect.all(closeEffects, { concurrency: "unbounded", discard: true });
          yield* Effect.logInfo("Channel session shutdown complete.");
        }).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.logWarning("Timed out waiting for sessions to shut down."),
          }),
          Effect.catch((error: unknown) =>
            Effect.logWarning(`Session shutdown failed: ${String(error)}`),
          ),
        );
        yield* Effect.logInfo("Shutdown cleanup complete.");
      }),
  );
};

export class ChannelSessions extends Context.Service<ChannelSessions, ChannelSessionsShape>()(
  "bubblebuddy/ChannelSessions",
) {
  static readonly layer = Layer.effect(ChannelSessions, makeChannelSessions());
}
