import { randomUUID } from "node:crypto";
import { Clock, Context, Cron, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const AfterTiming = Schema.Struct({
  kind: Schema.tag("after"),
  seconds: Schema.Finite,
});

export const AtTiming = Schema.Struct({
  kind: Schema.tag("at"),
  timestamp: Schema.String,
});

export const CronTiming = Schema.Struct({
  kind: Schema.tag("cron"),
  expression: Schema.String,
  timezone: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
});

export const Timing = Schema.Union([AfterTiming, AtTiming, CronTiming]).pipe(
  Schema.toTaggedUnion("kind"),
);
export type Timing = typeof Timing.Type;

export const Once = Schema.Struct({ kind: Schema.tag("once") });

export const CronRecurrence = Schema.Struct({
  kind: Schema.tag("cron"),
  expression: CronTiming.fields.expression,
  timezone: CronTiming.fields.timezone,
  expiresAt: Schema.NullOr(Schema.Finite),
});

export const Recurrence = Schema.Union([Once, CronRecurrence]).pipe(Schema.toTaggedUnion("kind"));
export type Recurrence = typeof Recurrence.Type;

export const CreateInput = Schema.Struct({
  description: Schema.String,
  note: Schema.String,
  timing: Timing,
});
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const UpdateInput = Schema.Struct({
  timing: Schema.optionalKey(CreateInput.fields.timing),
  description: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
});
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}

export const Wakeup = Schema.Struct({
  id: Schema.String,
  channelId: Schema.String,
  description: Schema.String,
  note: Schema.String,
  nextRunAt: Schema.Finite,
  recurrence: Recurrence,
});
export interface Wakeup extends Schema.Schema.Type<typeof Wakeup> {}

export const UpdateResult = Schema.Struct({
  before: Wakeup,
  after: Wakeup,
});
export interface UpdateResult extends Schema.Schema.Type<typeof UpdateResult> {}

export const describe = (wakeup: Wakeup): string =>
  [
    `Schedule: ${wakeup.id}`,
    `Description: ${wakeup.description}`,
    `Timing: ${Recurrence.match(wakeup.recurrence, {
      once: () => "once",
      cron: ({ expression, timezone, expiresAt }) =>
        `cron ${expression} (${timezone})${expiresAt === null ? "" : `, ends ${new Date(expiresAt).toISOString()}`}`,
    })}`,
    `Scheduled for: ${new Date(wakeup.nextRunAt).toISOString()}`,
    "",
    "Note:",
    wakeup.note,
  ].join("\n");

const Row = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  description: Schema.String,
  expires_at: Schema.NullOr(Schema.Finite),
  note: Schema.String,
  next_run_at: Schema.Finite,
  cron: Schema.NullOr(Schema.String),
  timezone: Schema.NullOr(Schema.String),
});

export class ValidationError extends Schema.TaggedError<ValidationError>()(
  "Schedules.ValidationError",
  {
    message: Schema.String,
  },
) {}
export class StoreError extends Schema.TaggedError<StoreError>()("Schedules.StoreError", {
  message: Schema.String,
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const invalid = (message: string) => new ValidationError({ message });

const validateNote = Effect.fn("Schedules.validateNote")(function* (value: string) {
  const note = value.trim();
  if (note.length === 0) return yield* invalid("A self-contained note is required.");
  return note;
});

const validateDescription = Effect.fn("Schedules.validateDescription")(function* (value: string) {
  const description = value.replaceAll(/\s+/g, " ").trim();
  if (description.length === 0 || description.length > 120) {
    return yield* invalid("Description must contain 1–120 characters.");
  }
  return description;
});

const parseTimestamp = Effect.fn("Schedules.parseTimestamp")(function* (value: string) {
  const timestamp = Date.parse(value);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isSafeInteger(timestamp)) {
    return yield* invalid("Timestamp must be valid and include a time and explicit UTC offset.");
  }
  return timestamp;
});

const storeError = (operation: string, cause: unknown) =>
  new StoreError({
    message: `Schedules store operation "${operation}" failed`,
    operation,
    cause,
  });

const mapError = (operation: string) =>
  Effect.mapError((cause: unknown) =>
    cause instanceof ValidationError ? cause : storeError(operation, cause),
  );

const nextCron = Effect.fn("Schedules.nextCron")(function* (
  expression: string,
  timezone: string,
  now: number,
) {
  const cron = yield* Effect.fromResult(Cron.parse(expression, timezone)).pipe(
    Effect.mapError((error) => invalid(error.message)),
  );
  if (cron.seconds.size !== 1) {
    return yield* invalid("Cron must not repeat more often than once a minute.");
  }
  return yield* Effect.try({
    try: () => Cron.next(cron, now).getTime(),
    catch: () => invalid("Cron expression has no calculable next occurrence."),
  });
});

const decodeRows = Effect.fn("Schedules.decodeRows")(function* (rows: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows);
  return decoded.map((row) =>
    Wakeup.make({
      id: row.id,
      channelId: row.channel_id,
      description: row.description,
      note: row.note,
      nextRunAt: row.next_run_at,
      recurrence:
        row.cron !== null && row.timezone !== null
          ? CronRecurrence.make({
              expression: row.cron,
              timezone: row.timezone,
              expiresAt: row.expires_at,
            })
          : Once.make({}),
    }),
  );
});

const resolveTiming = Effect.fn("Schedules.resolveTiming")(function* (timing: Timing, now: number) {
  const resolved = yield* Timing.match(timing, {
    after: ({ seconds }) =>
      seconds <= 0
        ? Effect.fail(invalid("Delay must be positive."))
        : Effect.succeed({ nextRunAt: now + Math.ceil(seconds * 1000), recurrence: Once.make({}) }),
    at: ({ timestamp }) =>
      parseTimestamp(timestamp).pipe(
        Effect.map((nextRunAt) => ({ nextRunAt, recurrence: Once.make({}) })),
      ),
    cron: ({ expression, timezone, expiresAt }) =>
      Effect.gen(function* () {
        const nextRunAt = yield* nextCron(expression, timezone, now);
        const expires = expiresAt === undefined ? null : yield* parseTimestamp(expiresAt);
        if (expires !== null && expires <= nextRunAt) {
          return yield* invalid("Expiration must be after the next occurrence.");
        }
        return {
          nextRunAt,
          recurrence: CronRecurrence.make({
            expression: expression.trim(),
            timezone,
            expiresAt: expires,
          }),
        };
      }),
  });
  if (Option.isNone(DateTime.make(resolved.nextRunAt)) || resolved.nextRunAt <= now) {
    return yield* invalid("Schedule must resolve to a valid future time.");
  }
  return resolved;
});

interface RecurrenceColumns {
  readonly cron: string | null;
  readonly timezone: string | null;
  readonly expiresAt: number | null;
}

const recurrenceColumns = (recurrence: Recurrence): RecurrenceColumns =>
  Recurrence.match(recurrence, {
    once: (): RecurrenceColumns => ({ cron: null, timezone: null, expiresAt: null }),
    cron: ({ expression, timezone, expiresAt }): RecurrenceColumns => ({
      cron: expression,
      timezone,
      expiresAt,
    }),
  });

const makeSchedules = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const create = Effect.fn("Schedules.create")(function* (channelId: string, input: CreateInput) {
    const decoded = yield* Schema.decodeEffect(CreateInput, { onExcessProperty: "error" })(
      input,
    ).pipe(Effect.mapError((error) => invalid(error.message)));
    const description = yield* validateDescription(decoded.description);
    const note = yield* validateNote(decoded.note);

    const now = yield* Clock.currentTimeMillis;
    const { nextRunAt, recurrence } = yield* resolveTiming(decoded.timing, now);

    const wakeup = Wakeup.make({
      id: randomUUID(),
      channelId,
      description,
      note,
      nextRunAt,
      recurrence,
    });
    const storedRecurrence = recurrenceColumns(wakeup.recurrence);

    yield* sql`
      INSERT INTO scheduled_wakeups (
        id, channel_id, description, expires_at, note, next_run_at, cron, timezone
      )
      VALUES (
        ${wakeup.id}, ${channelId}, ${description}, ${storedRecurrence.expiresAt}, ${note}, ${nextRunAt},
        ${storedRecurrence.cron},
        ${storedRecurrence.timezone}
      )
    `.pipe(mapError("create"));

    return wakeup;
  });

  const list = Effect.fn("Schedules.list")(function* (channelId: string) {
    const now = yield* Clock.currentTimeMillis;
    return yield* sql`SELECT * FROM scheduled_wakeups WHERE channel_id = ${channelId}
      AND (expires_at IS NULL OR expires_at > ${now})
      ORDER BY next_run_at, id`.pipe(Effect.flatMap(decodeRows), mapError("list"));
  });

  const cancel = Effect.fn("Schedules.cancel")(function* (channelId: string, id: string) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql`DELETE FROM scheduled_wakeups
      WHERE channel_id = ${channelId} AND id = ${id}
      AND (expires_at IS NULL OR expires_at > ${now}) RETURNING *`.pipe(
      Effect.flatMap(decodeRows),
      mapError("cancel"),
    );

    if (rows[0] === undefined) {
      return yield* invalid("No active schedule found in this channel.");
    }

    return rows[0];
  });

  const update = Effect.fn("Schedules.update")(function* (
    channelId: string,
    id: string,
    input: UpdateInput,
  ) {
    const decoded = yield* Schema.decodeEffect(UpdateInput, { onExcessProperty: "error" })(
      input,
    ).pipe(Effect.mapError((error) => invalid(error.message)));

    if (
      decoded.description === undefined &&
      decoded.note === undefined &&
      decoded.timing === undefined
    ) {
      return yield* invalid("Provide at least one field to update.");
    }

    const description =
      decoded.description === undefined
        ? undefined
        : yield* validateDescription(decoded.description);
    const note = decoded.note === undefined ? undefined : yield* validateNote(decoded.note);

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* sql`
            SELECT * FROM scheduled_wakeups
            WHERE channel_id = ${channelId} AND id = ${id}
              AND (expires_at IS NULL OR expires_at > ${now})
          `.pipe(Effect.flatMap(decodeRows));

          const current = rows[0];
          if (current === undefined) {
            return yield* invalid("No active schedule found in this channel.");
          }

          const timing =
            decoded.timing === undefined
              ? { nextRunAt: current.nextRunAt, recurrence: current.recurrence }
              : yield* resolveTiming(decoded.timing, now);
          const updated = {
            ...current,
            ...timing,
            description: description ?? current.description,
            note: note ?? current.note,
          };
          const storedRecurrence = recurrenceColumns(updated.recurrence);

          yield* sql`
            UPDATE scheduled_wakeups
            SET description = ${updated.description},
                note = ${updated.note},
                expires_at = ${storedRecurrence.expiresAt},
                next_run_at = ${updated.nextRunAt},
                cron = ${storedRecurrence.cron},
                timezone = ${storedRecurrence.timezone}
            WHERE channel_id = ${channelId} AND id = ${id}
          `;

          return UpdateResult.make({
            before: current,
            after: updated,
          });
        }),
      )
      .pipe(mapError("update"));
  });

  const takeDue = Effect.fn("Schedules.takeDue")(function* (now: number) {
    // Consume before dispatch: best-effort wakeups, not durable job execution.
    // Advancing from now coalesces missed cron ticks into one wakeup.
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM scheduled_wakeups WHERE expires_at <= ${now}`;

          const due = yield* sql`
            SELECT * FROM scheduled_wakeups
            WHERE next_run_at <= ${now}
            ORDER BY next_run_at, id
          `.pipe(Effect.flatMap(decodeRows));

          for (const wakeup of due) {
            if (Recurrence.guards.once(wakeup.recurrence)) {
              yield* sql`DELETE FROM scheduled_wakeups WHERE id = ${wakeup.id}`;
            } else {
              const nextRunAt = yield* nextCron(
                wakeup.recurrence.expression,
                wakeup.recurrence.timezone,
                now,
              );
              if (
                wakeup.recurrence.expiresAt !== null &&
                nextRunAt >= wakeup.recurrence.expiresAt
              ) {
                yield* sql`DELETE FROM scheduled_wakeups WHERE id = ${wakeup.id}`;
              } else {
                yield* sql`UPDATE scheduled_wakeups SET next_run_at = ${nextRunAt} WHERE id = ${wakeup.id}`;
              }
            }
          }

          return due;
        }),
      )
      .pipe(mapError("takeDue"));
  });

  return Service.of({ create, list, cancel, update, takeDue });
});

export interface Interface {
  readonly create: (
    channelId: string,
    input: CreateInput,
  ) => Effect.Effect<Wakeup, ValidationError | StoreError>;
  readonly list: (
    channelId: string,
  ) => Effect.Effect<ReadonlyArray<Wakeup>, ValidationError | StoreError>;
  readonly cancel: (
    channelId: string,
    id: string,
  ) => Effect.Effect<Wakeup, ValidationError | StoreError>;
  readonly update: (
    channelId: string,
    id: string,
    input: UpdateInput,
  ) => Effect.Effect<UpdateResult, ValidationError | StoreError>;
  readonly takeDue: (
    now: number,
  ) => Effect.Effect<ReadonlyArray<Wakeup>, ValidationError | StoreError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "bubblebuddy/scheduling/Schedules",
) {}

export const layer = Layer.effect(Service, makeSchedules);

export * as Schedules from "./schedules.ts";
