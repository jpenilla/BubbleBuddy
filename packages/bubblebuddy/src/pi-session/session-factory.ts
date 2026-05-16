import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuildTextBasedChannel } from "discord.js";
import { Context, Data, Effect, FileSystem, Layer, Scope } from "effect";

import { ChannelStateRepository } from "../channels/state-repository.ts";
import { AppHome } from "../config/env.ts";
import { FileConfig } from "../config/file.ts";
import { LoadedResources } from "../resources.ts";
import type { SessionKeepAliveFactory } from "../channels/keep-alive.ts";
import type { PromptTemplateContext } from "../prompt/system-prompt.ts";
import { createPiChannelSession, type ScopedPiChannelSession } from "./session.ts";
import { PiContext } from "./context.ts";
import { WORKSPACE_CWD } from "../shared/constants.ts";

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

const makeFactory = () =>
  Effect.gen(function* () {
    const config = yield* FileConfig;
    const appHome = yield* AppHome;
    const stateRepository = yield* ChannelStateRepository;
    const fs = yield* FileSystem.FileSystem;
    const resources = yield* LoadedResources;
    const piContext = yield* PiContext;

    const channelStorageDirectory = (channelId: string) => join(appHome, "channel", channelId);
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
            appSkillPaths: [join(appHome, "skills")],
            channel: input.channel,
            getShowThinking: input.getShowThinking,
            hostWorkspaceDir: workspaceDir(input.channel.id),
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
  static readonly layer = Layer.effect(PiChannelSessionFactory, makeFactory());
}
