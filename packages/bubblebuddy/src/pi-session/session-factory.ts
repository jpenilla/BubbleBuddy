import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuildTextBasedChannel } from "discord.js";

import { Context, Data, Effect, FileSystem, Layer, Path, Scope } from "effect";

import { ChannelStateRepository } from "../channels/state-repository.ts";
import { FileConfig } from "../config/file.ts";
import { LoadedResources } from "../resources.ts";
import type { SessionKeepAliveFactory } from "../channels/keep-alive.ts";
import type { PromptTemplateContext } from "../pi-session/system-prompt.ts";
import { createPiChannelSession, type ScopedPiChannelSession } from "./session.ts";
import { PiContext } from "./context.ts";
import { WORKSPACE_CWD } from "../shared/constants.ts";
import { WorkspacePaths } from "../shared/workspace.ts";

export class PiChannelSessionFactoryError extends Data.TaggedError("PiChannelSessionFactoryError")<{
  readonly channelId: string;
  readonly operation: "storage" | "session";
  readonly cause: unknown;
}> {}

export interface PiChannelSessionFactoryCreateInput {
  readonly channelId: string;
  readonly channel: GuildTextBasedChannel;
  readonly promptContext: PromptTemplateContext;
  readonly makeKeepAlive: SessionKeepAliveFactory;
  readonly getShowThinking: () => boolean;
}

const makePiChannelSessionFactory = Effect.gen(function* () {
  const config = yield* FileConfig;
  const stateRepository = yield* ChannelStateRepository;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resources = yield* LoadedResources;
  const piContext = yield* PiContext;
  const workspacePaths = yield* WorkspacePaths;

  const loadSessionManager = (
    channelId: string,
    activeSession?: string,
  ): Effect.Effect<SessionManager, PiChannelSessionFactoryError> => {
    const dir = workspacePaths.sessionsDir(channelId);
    return Effect.gen(function* () {
      yield* fs
        .makeDirectory(dir, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) => new PiChannelSessionFactoryError({ channelId, operation: "storage", cause }),
          ),
        );

      if (activeSession === undefined) {
        return SessionManager.create(WORKSPACE_CWD, dir);
      }

      return yield* Effect.try({
        try: () => SessionManager.open(path.join(dir, activeSession), dir, WORKSPACE_CWD),
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
    create: (input) =>
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
        yield* fs
          .makeDirectory(workspacePaths.hostWorkspaceDir(input.channel.id), { recursive: true })
          .pipe(
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
          getShowThinking: input.getShowThinking,
          hostWorkspaceDir: workspacePaths.hostWorkspaceDir(input.channel.id),
          promptContext: input.promptContext,
          sessionManager,
          makeKeepAlive: input.makeKeepAlive,
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

        return pi;
      }).pipe(
        Effect.provideService(FileConfig, config),
        Effect.provideService(LoadedResources, resources),
        Effect.provideService(PiContext, piContext),
      ),
  });
});

export class PiChannelSessionFactory extends Context.Service<
  PiChannelSessionFactory,
  {
    readonly create: (
      input: PiChannelSessionFactoryCreateInput,
    ) => Effect.Effect<ScopedPiChannelSession, PiChannelSessionFactoryError, Scope.Scope>;
  }
>()("bubblebuddy/pi/PiChannelSessionFactory") {
  static readonly layerNoDeps = Layer.effect(PiChannelSessionFactory, makePiChannelSessionFactory);
  static readonly layer = PiChannelSessionFactory.layerNoDeps.pipe(
    Layer.provide(FileConfig.layer),
    Layer.provide(LoadedResources.layer),
    Layer.provide(ChannelStateRepository.layer),
    Layer.provide(PiContext.layer),
    Layer.provide(WorkspacePaths.layer),
  );
}
