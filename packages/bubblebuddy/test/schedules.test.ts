import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Clock, Effect, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";

import { AppHome } from "../src/config/env.ts";
import { AppDatabase } from "../src/database.ts";
import { Schedules } from "../src/scheduling/schedules.ts";

// Each call opens and closes its own database connection, including when reusing a directory.
const withSchedules = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Schedules.layer.pipe(
        Layer.provide(AppDatabase.layerNoDeps),
        Layer.provide(Layer.succeed(AppHome, directory)),
      ),
    ),
  );

const temporaryDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "bb-schedules-" });
});

it.layer(NodeServices.layer)("schedules", (it) => {
  it.effect("reopens an alarm after its deadline and consumes it only once", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* TestClock.setTime(Date.parse("2026-01-15T10:00:00Z"));
      const alarm = yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const alarm = yield* schedules.create("123", {
            note: "Remind <@456> to check the oven.",
            timing: { kind: "after", seconds: 60 },
          });
          yield* TestClock.adjust("59 seconds");
          expect(yield* schedules.takeDue(yield* Clock.currentTimeMillis)).toEqual([]);
          return alarm;
        }),
      );

      yield* TestClock.adjust("2 minutes");
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const due = yield* schedules.takeDue(yield* Clock.currentTimeMillis);
          expect(due).toHaveLength(1);
          expect(due[0]).toMatchObject({
            id: alarm.id,
            channelId: "123",
            note: "Remind <@456> to check the oven.",
          });
          expect(yield* schedules.takeDue(yield* Clock.currentTimeMillis)).toEqual([]);
        }),
      );
    }),
  );

  it.effect("coalesces missed cron ticks after reopening and resumes the local schedule", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      // Kathmandu is UTC+05:45: a local hourly schedule falls at :15 UTC.
      yield* TestClock.setTime(Date.parse("2026-01-15T00:00:00Z"));
      const schedule = yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          return yield* schedules.create("123", {
            note: "Post the hourly weather report.",
            timing: { kind: "cron", expression: "0 * * * *", timezone: "Asia/Kathmandu" },
          });
        }),
      );

      yield* TestClock.setTime(Date.parse("2026-01-15T04:10:00Z"));
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const expected = {
            id: schedule.id,
            channelId: "123",
            note: "Post the hourly weather report.",
            recurrence: {
              kind: "cron",
              expression: "0 * * * *",
              timezone: "Asia/Kathmandu",
            },
          };
          expect(yield* schedules.takeDue(yield* Clock.currentTimeMillis)).toEqual([
            { ...expected, nextRunAt: Date.parse("2026-01-15T00:15:00Z") },
          ]);
          expect(yield* schedules.takeDue(yield* Clock.currentTimeMillis)).toEqual([]);

          yield* TestClock.setTime(Date.parse("2026-01-15T04:15:00Z"));
          expect(yield* schedules.takeDue(yield* Clock.currentTimeMillis)).toEqual([
            { ...expected, nextRunAt: Date.parse("2026-01-15T04:15:00Z") },
          ]);
        }),
      );
    }),
  );

  it.effect("cancels a listed alarm while leaving another alarm runnable", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* TestClock.setTime(Date.parse("2026-01-15T10:00:00Z"));
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const obsolete = yield* schedules.create("123", {
            note: "An obsolete reminder.",
            timing: { kind: "at", timestamp: "2026-01-15T10:01:00Z" },
          });
          const remaining = yield* schedules.create("123", {
            note: "The reminder to keep.",
            timing: { kind: "at", timestamp: "2026-01-15T10:02:00Z" },
          });
          expect((yield* schedules.list("123")).map((alarm) => alarm.id)).toEqual([
            obsolete.id,
            remaining.id,
          ]);
          expect(yield* schedules.cancel("123", obsolete.id)).toBe(true);

          yield* TestClock.adjust("3 minutes");
          expect(yield* schedules.takeDue(yield* Clock.currentTimeMillis)).toEqual([remaining]);
        }),
      );
    }),
  );
});
