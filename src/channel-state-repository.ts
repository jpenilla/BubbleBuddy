import { join } from "node:path";

import { Context, Data, Effect, FileSystem, Layer, RcMap } from "effect";

import { AppConfig } from "./config.ts";

const CHANNEL_FILE_NAME = "channel.json";

export const SHOW_THINKING_DEFAULT = false;

export interface PersistentChannelState {
  activeSession?: string;
  showThinking?: boolean;
}

export class ChannelStateRepositoryError extends Data.TaggedError("ChannelStateRepositoryError")<{
  readonly channelId: string;
  readonly operation: "load" | "save";
  readonly cause: unknown;
}> {}

export interface ChannelStateRepositoryShape {
  getActiveSession(
    channelId: string,
  ): Effect.Effect<string | undefined, ChannelStateRepositoryError>;
  setActiveSession(
    channelId: string,
    value: string,
  ): Effect.Effect<void, ChannelStateRepositoryError>;
  clearActiveSession(channelId: string): Effect.Effect<void, ChannelStateRepositoryError>;
  getShowThinking(channelId: string): Effect.Effect<boolean, ChannelStateRepositoryError>;
  setShowThinking(
    channelId: string,
    value: boolean,
  ): Effect.Effect<void, ChannelStateRepositoryError>;
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
            return {};
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
          Effect.acquireRelease(load(channelId), (state) =>
            save(channelId, state).pipe(
              Effect.ignore({
                log: "Error",
                message: `Failed to persist channel ${channelId}`,
              }),
            ),
          ),
        idleTimeToLive: "30 seconds",
      });

      const withState = <A>(channelId: string, f: (state: PersistentChannelState) => A) =>
        Effect.scoped(RcMap.get(states, channelId).pipe(Effect.map(f)));

      return ChannelStateRepository.of({
        getActiveSession: (channelId) => withState(channelId, (state) => state.activeSession),
        setActiveSession: (channelId, value) =>
          withState(channelId, (state) => {
            state.activeSession = value;
          }),
        clearActiveSession: (channelId) =>
          withState(channelId, (state) => {
            delete state.activeSession;
          }),
        getShowThinking: (channelId) =>
          withState(channelId, (state) => state.showThinking ?? SHOW_THINKING_DEFAULT),
        setShowThinking: (channelId, value) =>
          withState(channelId, (state) => {
            if (value === SHOW_THINKING_DEFAULT) {
              delete state.showThinking;
            } else {
              state.showThinking = value;
            }
          }),
      });
    }),
  );
}
