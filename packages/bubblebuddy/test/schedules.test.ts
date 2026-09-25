import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Layer, Stream } from "effect";
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

// Consumes the feed's first wakeup into a `Deferred`, so tests can assert that nothing
// fired before a deadline instead of blocking on the stream.
const consumeFirstWakeup = (schedules: Schedules.Interface) =>
  Effect.gen(function* () {
    const fired = yield* Deferred.make<ReadonlyArray<Schedules.Wakeup>>();
    yield* schedules.due.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.onExit((exit) => Deferred.done(fired, exit).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
    // Let the idle feed park before scheduling work, so a change notification has to wake it.
    yield* TestClock.adjust("0 seconds");
    return fired;
  });

it.layer(NodeServices.layer)("schedules", (it) => {
  it.effect("rejects cron that repeats more often than once a minute", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const error = yield* schedules
            .create("123", {
              description: "Reminder",
              note: "Reminder",
              timing: Schedules.CronTiming.make({
                expression: "* * * * * *",
                timezone: "UTC",
              }),
            })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(Schedules.ValidationError);
        }),
      );
    }),
  );

  it.effect("reopens an alarm after its deadline and consumes it only once", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* TestClock.setTime(Date.parse("2026-01-15T10:00:00Z"));
      const alarm = yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const alarm = yield* schedules.create("123", {
            description: "Check the oven",
            note: "Remind <@456> to check the oven.",
            timing: Schedules.AfterTiming.make({ seconds: 60 }),
          });
          yield* TestClock.adjust("59 seconds");
          expect(yield* schedules.list("123")).toEqual([alarm]);
          return alarm;
        }),
      );

      yield* TestClock.adjust("2 minutes");
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const due = yield* schedules.due.pipe(Stream.take(1), Stream.runCollect);
          expect(due).toHaveLength(1);
          expect(due[0]).toMatchObject({
            id: alarm.id,
            channelId: "123",
            note: "Remind <@456> to check the oven.",
          });
          expect(yield* schedules.list("123")).toEqual([]);
        }),
      );
    }),
  );

  it.effect("emits every wakeup that came due in one batch", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* TestClock.setTime(Date.parse("2026-01-15T10:00:00Z"));
      const [first, second] = yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const first = yield* schedules.create("123", {
            description: "First reminder",
            note: "The first reminder.",
            timing: Schedules.AtTiming.make({ timestamp: "2026-01-15T10:01:00Z" }),
          });
          const second = yield* schedules.create("123", {
            description: "Second reminder",
            note: "The second reminder.",
            timing: Schedules.AtTiming.make({ timestamp: "2026-01-15T10:02:00Z" }),
          });
          return [first, second] as const;
        }),
      );

      // Both deadlines elapse before the feed ever reads, so one pass picks up both.
      yield* TestClock.adjust("2 minutes");
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          expect(yield* schedules.due.pipe(Stream.take(2), Stream.runCollect)).toEqual([
            first,
            second,
          ]);
          expect(yield* schedules.list("123")).toEqual([]);
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
            description: "Hourly weather",
            note: "Post the hourly weather report.",
            timing: Schedules.CronTiming.make({
              expression: "0 * * * *",
              timezone: "Asia/Kathmandu",
            }),
          });
        }),
      );

      yield* TestClock.setTime(Date.parse("2026-01-15T04:10:00Z"));
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const expected = {
            description: "Hourly weather",
            id: schedule.id,
            channelId: "123",
            note: "Post the hourly weather report.",
            recurrence: Schedules.CronRecurrence.make({
              expression: "0 * * * *",
              timezone: "Asia/Kathmandu",
              expiresAt: null,
            }),
          };
          expect(yield* schedules.due.pipe(Stream.take(1), Stream.runCollect)).toEqual([
            { ...expected, nextRunAt: Date.parse("2026-01-15T00:15:00Z") },
          ]);
          expect(yield* schedules.list("123")).toEqual([
            { ...expected, nextRunAt: Date.parse("2026-01-15T04:15:00Z") },
          ]);

          yield* TestClock.setTime(Date.parse("2026-01-15T04:15:00Z"));
          expect(yield* schedules.due.pipe(Stream.take(1), Stream.runCollect)).toEqual([
            { ...expected, nextRunAt: Date.parse("2026-01-15T04:15:00Z") },
          ]);
        }),
      );
    }),
  );

  it.effect("coalesces missed anchored interval ticks after reopening", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* TestClock.setTime(Date.parse("2026-01-15T10:00:00Z"));
      const schedule = yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          return yield* schedules.create("123", {
            description: "Check progress",
            note: "Check progress.",
            timing: Schedules.IntervalTiming.make({
              everySeconds: 90,
              anchorAt: "2026-01-15T10:00:30Z",
            }),
          });
        }),
      );

      yield* TestClock.setTime(Date.parse("2026-01-15T10:05:10Z"));
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          expect(yield* schedules.due.pipe(Stream.take(1), Stream.runCollect)).toEqual([schedule]);
          expect(yield* schedules.list("123")).toMatchObject([
            { id: schedule.id, nextRunAt: Date.parse("2026-01-15T10:06:30Z") },
          ]);
        }),
      );
    }),
  );

  it.effect("fires the last interval occurrence before expiration and then removes it", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* TestClock.setTime(Date.parse("2026-01-15T10:00:00Z"));
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const schedule = yield* schedules.create("123", {
            description: "Check progress",
            note: "Check progress.",
            timing: Schedules.IntervalTiming.make({
              everySeconds: 60,
              anchorAt: "2026-01-15T10:03:00Z",
              expiresAt: "2026-01-15T10:04:30Z",
            }),
          });

          yield* TestClock.setTime(Date.parse("2026-01-15T10:03:00Z"));
          expect(yield* schedules.due.pipe(Stream.take(1), Stream.runCollect)).toEqual([schedule]);
          expect(yield* schedules.list("123")).toMatchObject([
            { id: schedule.id, nextRunAt: Date.parse("2026-01-15T10:04:00Z") },
          ]);

          yield* TestClock.setTime(Date.parse("2026-01-15T10:04:00Z"));
          expect(yield* schedules.due.pipe(Stream.take(1), Stream.runCollect)).toMatchObject([
            { id: schedule.id, nextRunAt: Date.parse("2026-01-15T10:04:00Z") },
          ]);
          expect(yield* schedules.list("123")).toEqual([]);
        }),
      );
    }),
  );

  it.effect("wakes an idle feed but fires an alarm only at its deadline", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* TestClock.setTime(Date.parse("2026-01-15T10:00:00Z"));
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const fired = yield* consumeFirstWakeup(schedules);

          const alarm = yield* schedules.create("123", {
            description: "Check the oven",
            note: "Remind <@456> to check the oven.",
            timing: Schedules.AfterTiming.make({ seconds: 60 }),
          });

          yield* TestClock.adjust("59 seconds");
          expect(yield* Deferred.isDone(fired)).toBe(false);

          yield* TestClock.adjust("1 second");
          expect(yield* Deferred.isDone(fired)).toBe(true);
          expect(yield* Deferred.await(fired)).toEqual([alarm]);
          expect(yield* schedules.list("123")).toEqual([]);
        }),
      );
    }),
  );

  it.effect("honors a deadline moved earlier while the feed waits", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* TestClock.setTime(Date.parse("2026-01-15T10:00:00Z"));
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const fired = yield* consumeFirstWakeup(schedules);

          const alarm = yield* schedules.create("123", {
            description: "Check the oven",
            note: "Remind <@456> to check the oven.",
            timing: Schedules.AfterTiming.make({ seconds: 300 }),
          });

          yield* TestClock.adjust("10 seconds");
          // Sooner than the feed's maximum wait, so only the change notification can
          // deliver it on time.
          const moved = yield* schedules.update("123", alarm.id, {
            timing: Schedules.AfterTiming.make({ seconds: 30 }),
          });

          yield* TestClock.adjust("29 seconds");
          expect(yield* Deferred.isDone(fired)).toBe(false);

          yield* TestClock.adjust("1 second");
          expect(yield* Deferred.isDone(fired)).toBe(true);
          expect(yield* Deferred.await(fired)).toEqual([moved.after]);
        }),
      );
    }),
  );

  it.effect("cancels a waiting alarm while leaving another alarm runnable", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* TestClock.setTime(Date.parse("2026-01-15T10:00:00Z"));
      yield* withSchedules(
        directory,
        Effect.gen(function* () {
          const schedules = yield* Schedules.Service;
          const fired = yield* consumeFirstWakeup(schedules);

          const obsolete = yield* schedules.create("123", {
            description: "Obsolete reminder",
            note: "An obsolete reminder.",
            timing: Schedules.AtTiming.make({ timestamp: "2026-01-15T10:01:00Z" }),
          });
          const remaining = yield* schedules.create("123", {
            description: "Reminder to keep",
            note: "The reminder to keep.",
            timing: Schedules.AtTiming.make({ timestamp: "2026-01-15T10:02:00Z" }),
          });
          expect((yield* schedules.list("123")).map((alarm) => alarm.id)).toEqual([
            obsolete.id,
            remaining.id,
          ]);

          yield* TestClock.adjust("30 seconds");
          expect(yield* schedules.cancel("123", obsolete.id)).toEqual(obsolete);

          yield* TestClock.adjust("30 seconds");
          expect(yield* Deferred.isDone(fired)).toBe(false);

          yield* TestClock.adjust("1 minute");
          expect(yield* Deferred.isDone(fired)).toBe(true);
          expect(yield* Deferred.await(fired)).toEqual([remaining]);
          expect(yield* schedules.list("123")).toEqual([]);
        }),
      );
    }),
  );
});
