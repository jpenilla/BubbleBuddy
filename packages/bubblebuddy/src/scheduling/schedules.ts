import { randomUUID } from "node:crypto";
import { Clock, Context, Cron, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

const CronTiming = Schema.Struct({
  kind: Schema.tag("cron"),
  expression: Schema.String,
  timezone: Schema.String,
});
export const CreateInput = Schema.Struct({
  note: Schema.NonEmptyString,
  timing: Schema.Union([
    Schema.Struct({ kind: Schema.tag("after"), seconds: Schema.Finite }),
    Schema.Struct({ kind: Schema.tag("at"), timestamp: Schema.String }),
    CronTiming,
  ]),
});
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const Wakeup = Schema.Struct({
  id: Schema.String,
  channelId: Schema.String,
  note: Schema.String,
  nextRunAt: Schema.Finite,
  recurrence: Schema.Union([Schema.Struct({ kind: Schema.tag("once") }), CronTiming]),
});
export interface Wakeup extends Schema.Schema.Type<typeof Wakeup> {}

const Row = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  note: Schema.String,
  next_run_at: Schema.Finite,
  cron: Schema.NullOr(Schema.String),
  timezone: Schema.NullOr(Schema.String),
});

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const invalid = (message: string) => new ValidationError({ message });
const storeError = (operation: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new StoreError({
        message: `Schedules store operation "${operation}" failed`,
        operation,
        cause,
      }),
  );

const nextCron = Effect.fn("Schedules.nextCron")(function* (
  expression: string,
  timezone: string,
  now: number,
) {
  const cron = yield* Effect.fromResult(Cron.parse(expression, timezone)).pipe(
    Effect.mapError((error) => invalid(error.message)),
  );
  return yield* Effect.try({
    try: () => Cron.next(cron, now).getTime(),
    catch: () => invalid("Cron expression has no calculable next occurrence."),
  });
});

const decodeRows = Effect.fn("Schedules.decodeRows")(function* (rows: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows);
  return yield* Effect.forEach(decoded, (row) => {
    if ((row.cron === null) !== (row.timezone === null)) {
      return Effect.fail(invalid("Invalid persisted cron/timezone pair."));
    }
    return Effect.succeed(
      Wakeup.make({
        id: row.id,
        channelId: row.channel_id,
        note: row.note,
        nextRunAt: row.next_run_at,
        recurrence:
          row.cron !== null && row.timezone !== null
            ? { kind: "cron", expression: row.cron, timezone: row.timezone }
            : { kind: "once" },
      }),
    );
  });
});

const makeSchedules = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const create = Effect.fn("Schedules.create")(function* (channelId: string, input: CreateInput) {
    const decoded = yield* Schema.decodeEffect(CreateInput)(input).pipe(Effect.orDie);
    const note = decoded.note.trim();
    if (note.length === 0) return yield* invalid("A self-contained note is required.");
    const now = yield* Clock.currentTimeMillis;
    const timing = decoded.timing;
    let nextRunAt: number;
    switch (timing.kind) {
      case "after":
        if (!Number.isFinite(timing.seconds) || timing.seconds <= 0)
          return yield* invalid("Delay must be a finite positive number of seconds.");
        nextRunAt = now + Math.ceil(timing.seconds * 1000);
        break;
      case "at":
        if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(timing.timestamp))
          return yield* invalid("Timestamp must include a time and explicit UTC offset.");
        nextRunAt = Date.parse(timing.timestamp);
        break;
      case "cron":
        nextRunAt = yield* nextCron(timing.expression, timing.timezone, now);
        break;
    }
    if (
      !Number.isSafeInteger(nextRunAt) ||
      !Number.isFinite(new Date(nextRunAt).getTime()) ||
      nextRunAt <= now
    )
      return yield* invalid("Schedule must resolve to a valid future time.");
    const wakeup = Wakeup.make({
      id: randomUUID(),
      channelId,
      note,
      nextRunAt,
      recurrence: timing.kind === "cron" ? timing : { kind: "once" },
    });
    yield* sql`INSERT INTO scheduled_wakeups (id, channel_id, note, next_run_at, cron, timezone)
      VALUES (${wakeup.id}, ${channelId}, ${note}, ${nextRunAt},
        ${timing.kind === "cron" ? timing.expression : null},
        ${timing.kind === "cron" ? timing.timezone : null})`.pipe(storeError("create"));
    return wakeup;
  });
  const list = Effect.fn("Schedules.list")(function* (channelId: string) {
    return yield* sql`SELECT * FROM scheduled_wakeups WHERE channel_id = ${channelId}
      ORDER BY next_run_at, id`.pipe(Effect.flatMap(decodeRows), storeError("list"));
  });
  const cancel = Effect.fn("Schedules.cancel")(function* (channelId: string, id: string) {
    const rows = yield* sql`DELETE FROM scheduled_wakeups
      WHERE channel_id = ${channelId} AND id = ${id} RETURNING id`.pipe(storeError("cancel"));
    return rows.length > 0;
  });
  const takeDue = Effect.fn("Schedules.takeDue")(function* (now: number) {
    // Consume before dispatch: best-effort wakeups, not durable job execution.
    // Advancing from now coalesces missed cron ticks into one wakeup.
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const due = yield* sql`SELECT * FROM scheduled_wakeups WHERE next_run_at <= ${now}
        ORDER BY next_run_at, id`.pipe(Effect.flatMap(decodeRows));
          for (const wakeup of due) {
            if (wakeup.recurrence.kind === "once") {
              yield* sql`DELETE FROM scheduled_wakeups WHERE id = ${wakeup.id}`;
            } else {
              const next = yield* nextCron(
                wakeup.recurrence.expression,
                wakeup.recurrence.timezone,
                now,
              );
              yield* sql`UPDATE scheduled_wakeups SET next_run_at = ${next} WHERE id = ${wakeup.id}`;
            }
          }
          return due;
        }),
      )
      .pipe(storeError("takeDue"));
  });
  return Service.of({ create, list, cancel, takeDue });
});

export interface Interface {
  readonly create: (
    channelId: string,
    input: CreateInput,
  ) => Effect.Effect<Wakeup, ValidationError | StoreError>;
  readonly list: (channelId: string) => Effect.Effect<ReadonlyArray<Wakeup>, StoreError>;
  readonly cancel: (channelId: string, id: string) => Effect.Effect<boolean, StoreError>;
  readonly takeDue: (now: number) => Effect.Effect<ReadonlyArray<Wakeup>, StoreError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "bubblebuddy/scheduling/Schedules",
) {}

export const layer = Layer.effect(Service, makeSchedules);

export * as Schedules from "./schedules.ts";
