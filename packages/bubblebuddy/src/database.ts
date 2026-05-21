import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { AppHome } from "./config/env.ts";

const DATABASE_FILE_NAME = "bubblebuddy.sqlite";

export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const appHome = yield* AppHome;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(appHome, { recursive: true });

    return MigrationsLayer.pipe(
      Layer.provideMerge(
        SqliteClient.layer({
          filename: path.join(appHome, DATABASE_FILE_NAME),
        }),
      ),
    );
  }),
);

const initialSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
});

export const MigrationsLayer = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "1_initial_schema": initialSchema,
  }),
});
