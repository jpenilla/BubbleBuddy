import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

import {
  REPLY_MODE_DEFAULT,
  ReplyModeSchema,
  SHOW_THINKING_DEFAULT,
  type ReplyMode,
} from "./state.ts";

export class Error extends Schema.TaggedError<Error>()("ChannelStateRepository.Error", {
  channelId: Schema.String,
  operation: Schema.Literals(["load", "save"]),
  cause: Schema.Defect(),
}) {}

const createChannelStateRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const mapToLoadError = (channelId: string) =>
    Effect.mapError((cause) => new Error({ channelId, operation: "load", cause }));
  const mapToSaveError = (channelId: string) =>
    Effect.mapError((cause) => new Error({ channelId, operation: "save", cause }));

  const deleteDefaultSettings = (channelId: string) =>
    sql`DELETE FROM channel_settings WHERE channel_id = ${channelId} AND show_thinking IS NULL AND reply_mode IS NULL`;

  const deleteDefaultSession = (channelId: string) =>
    sql`DELETE FROM channel_sessions WHERE channel_id = ${channelId} AND active_session IS NULL`;

  return Service.of({
    getActiveSession: (channelId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ active_session: string | null }>`
          SELECT active_session FROM channel_sessions WHERE channel_id = ${channelId}
        `;
        return rows[0]?.active_session ?? undefined;
      }).pipe(mapToLoadError(channelId)),

    setActiveSession: (channelId, value) =>
      sql`
        INSERT INTO channel_sessions (channel_id, active_session)
        VALUES (${channelId}, ${value})
        ON CONFLICT(channel_id) DO UPDATE SET active_session = excluded.active_session
      `.pipe(mapToSaveError(channelId)),

    clearActiveSession: (channelId) =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE channel_sessions SET active_session = NULL WHERE channel_id = ${channelId}
        `;
        yield* deleteDefaultSession(channelId);
      }).pipe(mapToSaveError(channelId)),

    getShowThinking: (channelId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ show_thinking: number | null }>`
          SELECT show_thinking FROM channel_settings WHERE channel_id = ${channelId}
        `;
        return rows[0]?.show_thinking === 1 ? true : SHOW_THINKING_DEFAULT;
      }).pipe(mapToLoadError(channelId)),

    setShowThinking: (channelId, value) =>
      Effect.gen(function* () {
        const storedValue = value === SHOW_THINKING_DEFAULT ? null : Number(value);
        yield* sql`
          INSERT INTO channel_settings (channel_id, show_thinking)
          VALUES (${channelId}, ${storedValue})
          ON CONFLICT(channel_id) DO UPDATE SET show_thinking = excluded.show_thinking
        `;
        yield* deleteDefaultSettings(channelId);
      }).pipe(mapToSaveError(channelId)),

    getReplyMode: (channelId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ reply_mode: unknown }>`
          SELECT reply_mode FROM channel_settings WHERE channel_id = ${channelId}
        `;
        const replyMode = rows[0]?.reply_mode;
        return replyMode == null
          ? REPLY_MODE_DEFAULT
          : yield* Schema.decodeUnknownEffect(ReplyModeSchema)(replyMode);
      }).pipe(mapToLoadError(channelId)),

    setReplyMode: (channelId, value) =>
      Effect.gen(function* () {
        const storedValue = value === REPLY_MODE_DEFAULT ? null : value;
        yield* sql`
          INSERT INTO channel_settings (channel_id, reply_mode)
          VALUES (${channelId}, ${storedValue})
          ON CONFLICT(channel_id) DO UPDATE SET reply_mode = excluded.reply_mode
        `;
        yield* deleteDefaultSettings(channelId);
      }).pipe(mapToSaveError(channelId)),
  });
});

export interface Interface {
  getActiveSession(channelId: string): Effect.Effect<string | undefined, Error>;
  setActiveSession(channelId: string, value: string): Effect.Effect<void, Error>;
  clearActiveSession(channelId: string): Effect.Effect<void, Error>;
  getShowThinking(channelId: string): Effect.Effect<boolean, Error>;
  setShowThinking(channelId: string, value: boolean): Effect.Effect<void, Error>;
  getReplyMode(channelId: string): Effect.Effect<ReplyMode, Error>;
  setReplyMode(channelId: string, value: ReplyMode): Effect.Effect<void, Error>;
}

export class Service extends Context.Service<Service, Interface>()(
  "bubblebuddy/session/ChannelStateRepository",
) {}

export const layer = Layer.effect(Service, createChannelStateRepository);

export * as ChannelStateRepository from "./state-repository.ts";
