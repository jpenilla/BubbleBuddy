import { join } from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Context, Data, Effect, FileSystem, Layer, Scope } from "effect";

import { ChannelStateRepository } from "../channel-state-repository.ts";
import type { CreateSessionParams } from "../channel-runtime.ts";
import { AppConfig } from "../config.ts";
import { LoadedResources } from "../resources.ts";
import type { SessionKeepAliveFactory } from "../session-keep-alive.ts";
import { createPiChannelSession, type ScopedPiChannelSession } from "./channel-session.ts";
import { PiContext } from "./context.ts";
import { WORKSPACE_CWD } from "./workspace.ts";

export class PiChannelSessionFactoryError extends Data.TaggedError("PiChannelSessionFactoryError")<{
  readonly channelId: string;
  readonly operation: "storage" | "session";
  readonly cause: unknown;
}> {}

const makeFactory = () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const stateRepository = yield* ChannelStateRepository;
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
    ): Effect.Effect<SessionManager, PiChannelSessionFactoryError> => {
      const dir = sessionsDir(channelId);
      return Effect.gen(function* () {
        yield* fs
          .makeDirectory(dir, { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PiChannelSessionFactoryError({ channelId, operation: "storage", cause }),
            ),
          );

        if (activeSession === undefined) {
          return SessionManager.create(WORKSPACE_CWD, dir);
        }

        return yield* Effect.try({
          try: () => SessionManager.open(join(dir, activeSession), dir, WORKSPACE_CWD),
          catch: (cause) =>
            new PiChannelSessionFactoryError({ channelId, operation: "storage", cause }),
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

    return PiChannelSessionFactory.of({
      create: (input, makeKeepAlive, getShowThinking) =>
        Effect.gen(function* () {
          const activeSession = yield* stateRepository.getActiveSession(input.channel.id).pipe(
            Effect.mapError(
              (cause) =>
                new PiChannelSessionFactoryError({
                  channelId: input.channel.id,
                  operation: "storage",
                  cause,
                }),
            ),
          );
          yield* fs.makeDirectory(workspaceDir(input.channel.id), { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new PiChannelSessionFactoryError({
                  channelId: input.channel.id,
                  operation: "storage",
                  cause,
                }),
            ),
          );
          const sessionManager = yield* loadSessionManager(input.channel.id, activeSession);

          const pi = yield* createPiChannelSession({
            channel: input.channel,
            getShowThinking,
            hostWorkspaceDir: workspaceDir(input.channel.id),
            promptContext: input.promptContext,
            sessionManager,
            makeKeepAlive,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new PiChannelSessionFactoryError({
                  channelId: input.channel.id,
                  operation: "session",
                  cause,
                }),
            ),
          );

          return { pi, sessionManager };
        }).pipe(
          Effect.provideService(AppConfig, config),
          Effect.provideService(LoadedResources, resources),
          Effect.provideService(PiContext, piContext),
        ),
    });
  });

export class PiChannelSessionFactory extends Context.Service<
  PiChannelSessionFactory,
  {
    readonly create: (
      input: CreateSessionParams,
      makeKeepAlive: SessionKeepAliveFactory,
      getShowThinking: () => boolean,
    ) => Effect.Effect<
      { pi: ScopedPiChannelSession; sessionManager: SessionManager },
      PiChannelSessionFactoryError,
      Scope.Scope
    >;
  }
>()("bubblebuddy/pi/PiChannelSessionFactory") {
  static readonly layer = Layer.effect(PiChannelSessionFactory, makeFactory());
}
