import { join } from "node:path";

import { Context, Data, Effect, FileSystem, Layer } from "effect";

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

export class ChannelRepositoryError extends Data.TaggedError("ChannelRepositoryError")<{
  readonly channelId: string;
  readonly operation: "load" | "save";
  readonly cause: unknown;
}> {}

export interface ChannelRepositoryShape {
  load(channelId: string): Effect.Effect<PersistentChannelState, ChannelRepositoryError>;
  save(
    channelId: string,
    state: PersistentChannelState,
  ): Effect.Effect<void, ChannelRepositoryError>;
}

export class ChannelRepository extends Context.Service<ChannelRepository, ChannelRepositoryShape>()(
  "bubblebuddy/ChannelRepository",
) {
  static readonly layer = Layer.effect(
    ChannelRepository,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;

      const channelDir = (channelId: string) => join(config.storageDirectory, "channel", channelId);
      const channelFilePath = (channelId: string) => join(channelDir(channelId), CHANNEL_FILE_NAME);

      return ChannelRepository.of({
        load: (channelId) =>
          Effect.gen(function* () {
            const path = channelFilePath(channelId);
            const exists = yield* fs
              .exists(path)
              .pipe(
                Effect.mapError(
                  (cause) => new ChannelRepositoryError({ channelId, operation: "load", cause }),
                ),
              );
            if (!exists) {
              return { settings: {} };
            }
            const raw = yield* fs
              .readFileString(path, "utf8")
              .pipe(
                Effect.mapError(
                  (cause) => new ChannelRepositoryError({ channelId, operation: "load", cause }),
                ),
              );
            return yield* Effect.try({
              try: () => JSON.parse(raw) as PersistentChannelState,
              catch: (cause) => new ChannelRepositoryError({ channelId, operation: "load", cause }),
            });
          }),
        save: (channelId, state) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(channelDir(channelId), { recursive: true });
            yield* fs.writeFileString(channelFilePath(channelId), JSON.stringify(state, null, 2));
          }).pipe(
            Effect.mapError(
              (cause) => new ChannelRepositoryError({ channelId, operation: "save", cause }),
            ),
          ),
      });
    }),
  );
}
