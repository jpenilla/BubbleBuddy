import { join } from "node:path";

import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Data, Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { AppConfig } from "./config.ts";

const DATABASE_FILE_NAME = "bubblebuddy.sqlite";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: "initialize";
  readonly cause: unknown;
}> {}

const initSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`
      CREATE TABLE IF NOT EXISTS channel_settings (
        channel_id TEXT PRIMARY KEY NOT NULL,
        show_thinking INTEGER
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS channel_sessions (
        channel_id TEXT PRIMARY KEY NOT NULL,
        active_session TEXT
      )
    `;
  }).pipe(Effect.mapError((cause) => new DatabaseError({ operation: "initialize", cause })));

export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(config.storageDirectory, { recursive: true })
      .pipe(Effect.mapError((cause) => new DatabaseError({ operation: "initialize", cause })));

    return SqliteClient.layer({
      filename: join(config.storageDirectory, DATABASE_FILE_NAME),
    }).pipe(Layer.tap((context) => initSchema(Context.get(context, SqlClient.SqlClient))));
  }),
);
