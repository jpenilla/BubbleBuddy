import { Context, Data, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const SHOW_THINKING_DEFAULT = false;

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
      const sql = yield* SqlClient.SqlClient;

      const mapLoadError = (channelId: string) =>
        Effect.mapError(
          (cause) => new ChannelStateRepositoryError({ channelId, operation: "load", cause }),
        );
      const mapSaveError = (channelId: string) =>
        Effect.mapError(
          (cause) => new ChannelStateRepositoryError({ channelId, operation: "save", cause }),
        );

      const deleteDefaultSettings = (channelId: string) =>
        sql`DELETE FROM channel_settings WHERE channel_id = ${channelId} AND show_thinking IS NULL`;

      const deleteDefaultSession = (channelId: string) =>
        sql`DELETE FROM channel_sessions WHERE channel_id = ${channelId} AND active_session IS NULL`;

      return ChannelStateRepository.of({
        getActiveSession: (channelId) =>
          Effect.gen(function* () {
            const rows = yield* sql<{ active_session: string | null }>`
              SELECT active_session FROM channel_sessions WHERE channel_id = ${channelId}
            `;
            return rows[0]?.active_session ?? undefined;
          }).pipe(mapLoadError(channelId)),

        setActiveSession: (channelId, value) =>
          sql`
            INSERT INTO channel_sessions (channel_id, active_session)
            VALUES (${channelId}, ${value})
            ON CONFLICT(channel_id) DO UPDATE SET active_session = excluded.active_session
          `.pipe(mapSaveError(channelId)),

        clearActiveSession: (channelId) =>
          Effect.gen(function* () {
            yield* sql`
              UPDATE channel_sessions SET active_session = NULL WHERE channel_id = ${channelId}
            `;
            yield* deleteDefaultSession(channelId);
          }).pipe(mapSaveError(channelId)),

        getShowThinking: (channelId) =>
          Effect.gen(function* () {
            const rows = yield* sql<{ show_thinking: number | null }>`
              SELECT show_thinking FROM channel_settings WHERE channel_id = ${channelId}
            `;
            return rows[0]?.show_thinking === 1 ? true : SHOW_THINKING_DEFAULT;
          }).pipe(mapLoadError(channelId)),

        setShowThinking: (channelId, value) =>
          Effect.gen(function* () {
            const storedValue = value === SHOW_THINKING_DEFAULT ? null : Number(value);
            yield* sql`
              INSERT INTO channel_settings (channel_id, show_thinking)
              VALUES (${channelId}, ${storedValue})
              ON CONFLICT(channel_id) DO UPDATE SET show_thinking = excluded.show_thinking
            `;
            yield* deleteDefaultSettings(channelId);
          }).pipe(mapSaveError(channelId)),
      });
    }),
  );
}
