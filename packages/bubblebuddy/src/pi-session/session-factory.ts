import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuildTextBasedChannel } from "discord.js";

import { Context, Data, Effect, FileSystem, Layer, Path, Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { ChannelStateRepository } from "../channels/state-repository.ts";
import { FileConfig } from "../config/file.ts";
import { LoadedResources } from "../resources.ts";
import type { SessionKeepAliveFactory } from "../channels/keep-alive.ts";
import type { PromptTemplateContext } from "../pi-session/system-prompt.ts";
import { createPiChannelSession, type ScopedPiChannelSession } from "./session.ts";
import { PiContext } from "./context.ts";
import { AppHome } from "../config/env.ts";
import { WORKSPACE_CWD } from "../shared/constants.ts";
import { channelHostSessionsDir, makeChannelMountedWorkspace } from "../shared/workspace.ts";

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
  const appHome = yield* AppHome;
  const http = yield* HttpClient.HttpClient;

  const loadSessionManager = (
    channelId: string,
    activeSession?: string,
  ): Effect.Effect<SessionManager, PiChannelSessionFactoryError> => {
    const dir = channelHostSessionsDir(path, appHome, channelId);
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
        const workspace = makeChannelMountedWorkspace(
          path,
          appHome,
          input.channel.id,
          WORKSPACE_CWD,
        );
        yield* fs.makeDirectory(workspace.root.host, { recursive: true }).pipe(
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
          workspace,
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
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(Path.Path, path),
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
    Layer.provide(AppHome.layer),
    Layer.provide(FetchHttpClient.layer),
  );
}
