import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { AppHome } from "./config/env.ts";

const DATABASE_FILE_NAME = "bubblebuddy.sqlite";

const initialSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE channel_settings (
      channel_id TEXT PRIMARY KEY NOT NULL,
      show_thinking INTEGER
    )
  `;
  yield* sql`
    CREATE TABLE channel_sessions (
      channel_id TEXT PRIMARY KEY NOT NULL,
      active_session TEXT
    )
  `;
});

const scheduledWakeups = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scheduled_wakeups (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL,
    note TEXT NOT NULL,
    next_run_at INTEGER NOT NULL,
    cron TEXT,
    timezone TEXT,
    CHECK ((cron IS NULL AND timezone IS NULL) OR (cron IS NOT NULL AND timezone IS NOT NULL))
  )`;
  yield* sql`CREATE INDEX scheduled_wakeups_due ON scheduled_wakeups (next_run_at)`;
});

const scheduleMetadata = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scheduled_wakeups_metadata (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL,
    description TEXT NOT NULL,
    expires_at INTEGER,
    note TEXT NOT NULL,
    next_run_at INTEGER NOT NULL,
    cron TEXT,
    timezone TEXT,
    CHECK ((cron IS NULL AND timezone IS NULL) OR (cron IS NOT NULL AND timezone IS NOT NULL))
  )`;
  yield* sql`INSERT INTO scheduled_wakeups_metadata
    (id, channel_id, description, expires_at, note, next_run_at, cron, timezone)
    SELECT id, channel_id, 'Scheduled task', NULL, note, next_run_at, cron, timezone
    FROM scheduled_wakeups`;
  yield* sql`DROP TABLE scheduled_wakeups`;
  yield* sql`ALTER TABLE scheduled_wakeups_metadata RENAME TO scheduled_wakeups`;
  yield* sql`CREATE INDEX scheduled_wakeups_due ON scheduled_wakeups (next_run_at)`;
});

const migrationsLayer = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "1_initial_schema": initialSchema,
    "2_scheduled_wakeups": scheduledWakeups,
    "3_schedule_metadata": scheduleMetadata,
  }),
});

export const layerNoDeps = Layer.unwrap(
  Effect.gen(function* () {
    const appHome = yield* AppHome;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(appHome, { recursive: true });

    return migrationsLayer.pipe(
      Layer.provideMerge(
        SqliteClient.layer({
          filename: path.join(appHome, DATABASE_FILE_NAME),
        }),
      ),
    );
  }),
);

export const layer = layerNoDeps.pipe(Layer.provide(AppHome.layer));

export * as AppDatabase from "./database.ts";
