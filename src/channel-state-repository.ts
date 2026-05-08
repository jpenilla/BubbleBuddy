import { join } from "node:path";

import { Context, Data, Effect, FileSystem, Layer, RcMap, Scope } from "effect";

import { makeChannelState, type ChannelState } from "./channel-state.ts";
import { AppConfig } from "./config.ts";

const CHANNEL_FILE_NAME = "channel.json";

export const SHOW_THINKING_DEFAULT = false;

export interface ChannelSettings {
  showThinking?: boolean;
}

export interface PersistentChannelState {
  activeSession?: string;
  settings: ChannelSettings;
}

export class ChannelStateRepositoryError extends Data.TaggedError("ChannelStateRepositoryError")<{
  readonly channelId: string;
  readonly operation: "load" | "save";
  readonly cause: unknown;
}> {}

export interface ChannelStateRepositoryShape {
  getState(
    channelId: string,
  ): Effect.Effect<ChannelState, ChannelStateRepositoryError, Scope.Scope>;
}

export class ChannelStateRepository extends Context.Service<
  ChannelStateRepository,
  ChannelStateRepositoryShape
>()("bubblebuddy/ChannelStateRepository") {
  static readonly layer = Layer.effect(
    ChannelStateRepository,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;

      const channelDir = (channelId: string) => join(config.storageDirectory, "channel", channelId);
      const channelFilePath = (channelId: string) => join(channelDir(channelId), CHANNEL_FILE_NAME);

      const load = (
        channelId: string,
      ): Effect.Effect<PersistentChannelState, ChannelStateRepositoryError> =>
        Effect.gen(function* () {
          const path = channelFilePath(channelId);
          const exists = yield* fs
            .exists(path)
            .pipe(
              Effect.mapError(
                (cause) => new ChannelStateRepositoryError({ channelId, operation: "load", cause }),
              ),
            );
          if (!exists) {
            return { settings: {} };
          }
          const raw = yield* fs
            .readFileString(path, "utf8")
            .pipe(
              Effect.mapError(
                (cause) => new ChannelStateRepositoryError({ channelId, operation: "load", cause }),
              ),
            );
          return yield* Effect.try({
            try: () => JSON.parse(raw) as PersistentChannelState,
            catch: (cause) =>
              new ChannelStateRepositoryError({ channelId, operation: "load", cause }),
          });
        });

      const save = (
        channelId: string,
        state: PersistentChannelState,
      ): Effect.Effect<void, ChannelStateRepositoryError> =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(channelDir(channelId), { recursive: true });
          yield* fs.writeFileString(channelFilePath(channelId), JSON.stringify(state, null, 2));
        }).pipe(
          Effect.mapError(
            (cause) => new ChannelStateRepositoryError({ channelId, operation: "save", cause }),
          ),
        );

      const states = yield* RcMap.make({
        lookup: (channelId: string) =>
          Effect.acquireRelease(
            load(channelId).pipe(
              Effect.map((persistent) => ({ persistent, state: makeChannelState(persistent) })),
            ),
            ({ persistent, state }) =>
              state.dirty
                ? save(channelId, persistent).pipe(
                    Effect.ignore({
                      log: "Error",
                      message: `Failed to persist channel ${channelId}`,
                    }),
                  )
                : Effect.void,
          ).pipe(Effect.map(({ state }) => state)),
        idleTimeToLive: config.channelIdleTimeoutMs,
      });

      return ChannelStateRepository.of({
        getState: (channelId) => RcMap.get(states, channelId),
      });
    }),
  );
}
