import { randomUUID } from "node:crypto";
import { Clock, Context, Cron, Effect, Layer, Schema } from "effect";
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
});

export const Timing = Schema.Union([AfterTiming, AtTiming, CronTiming]).pipe(
  Schema.toTaggedUnion("kind"),
);
export type Timing = typeof Timing.Type;

export const Once = Schema.Struct({ kind: Schema.tag("once") });

export const Recurrence = Schema.Union([Once, CronTiming]).pipe(Schema.toTaggedUnion("kind"));
export type Recurrence = typeof Recurrence.Type;

export const CreateInput = Schema.Struct({
  description: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
  note: Schema.NonEmptyString,
  timing: Timing,
});
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const UpdateInput = Schema.Struct({
  timing: Schema.optionalKey(CreateInput.fields.timing),
  description: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}

export const Wakeup = Schema.Struct({
  id: Schema.String,
  channelId: Schema.String,
  description: Schema.String,
  expiresAt: Schema.NullOr(Schema.Finite),
  note: Schema.String,
  nextRunAt: Schema.Finite,
  recurrence: Recurrence,
});
export interface Wakeup extends Schema.Schema.Type<typeof Wakeup> {}

export const ReplacedField = Schema.Literals(["description", "timing", "note", "expiresAt"]);
export type ReplacedField = typeof ReplacedField.Type;

export const UpdateResult = Schema.Struct({
  before: Wakeup,
  after: Wakeup,
  replacedFields: Schema.Array(ReplacedField),
});
export interface UpdateResult extends Schema.Schema.Type<typeof UpdateResult> {}

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

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const invalid = (message: string) => new ValidationError({ message });

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
        description: row.description,
        expiresAt: row.expires_at,
        note: row.note,
        nextRunAt: row.next_run_at,
        recurrence:
          row.cron !== null && row.timezone !== null
            ? CronTiming.make({ expression: row.cron, timezone: row.timezone })
            : Once.make({}),
      }),
    );
  });
});

const resolveTiming = Effect.fn("Schedules.resolveTiming")(function* (timing: Timing, now: number) {
  const nextRunAt = yield* Timing.match(timing, {
    after: ({ seconds }) => {
      if (seconds <= 0) {
        return Effect.fail(invalid("Delay must be positive."));
      }
      return Effect.succeed(now + Math.ceil(seconds * 1000));
    },
    at: ({ timestamp }) => parseTimestamp(timestamp),
    cron: ({ expression, timezone }) => {
      if (expression.trim().split(/\s+/).length !== 5) {
        return Effect.fail(
          invalid("Cron must contain exactly five fields (minute-level precision)."),
        );
      }
      return nextCron(expression, timezone, now);
    },
  });
  if (
    !Number.isSafeInteger(nextRunAt) ||
    !Number.isFinite(new Date(nextRunAt).getTime()) ||
    nextRunAt <= now
  ) {
    return yield* invalid("Schedule must resolve to a valid future time.");
  }
  return {
    nextRunAt,
    recurrence: Timing.guards.cron(timing)
      ? CronTiming.make({ expression: timing.expression, timezone: timing.timezone })
      : Once.make({}),
  };
});

interface RecurrenceColumns {
  readonly cron: string | null;
  readonly timezone: string | null;
}

const recurrenceColumns = (recurrence: Recurrence): RecurrenceColumns =>
  Recurrence.match(recurrence, {
    once: (): RecurrenceColumns => ({ cron: null, timezone: null }),
    cron: ({ expression, timezone }): RecurrenceColumns => ({ cron: expression, timezone }),
  });

const makeSchedules = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const create = Effect.fn("Schedules.create")(function* (channelId: string, input: CreateInput) {
    const decoded = yield* Schema.decodeEffect(CreateInput)(input).pipe(Effect.orDie);
    const description = yield* validateDescription(decoded.description);
    const expiresAt =
      decoded.expiresAt === undefined ? null : yield* parseTimestamp(decoded.expiresAt);
    const note = decoded.note.trim();

    if (note.length === 0) {
      return yield* invalid("A self-contained note is required.");
    }

    const now = yield* Clock.currentTimeMillis;
    const timing = decoded.timing;
    const { nextRunAt, recurrence } = yield* resolveTiming(timing, now);
    if (expiresAt !== null && expiresAt <= nextRunAt) {
      return yield* invalid("Expiration must be after the first occurrence.");
    }

    const wakeup = Wakeup.make({
      id: randomUUID(),
      channelId,
      description,
      expiresAt,
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
        ${wakeup.id}, ${channelId}, ${description}, ${expiresAt}, ${note}, ${nextRunAt},
        ${storedRecurrence.cron},
        ${storedRecurrence.timezone}
      )
    `.pipe(storeError("create"));

    return wakeup;
  });

  const list = Effect.fn("Schedules.list")(function* (channelId: string) {
    const now = yield* Clock.currentTimeMillis;
    return yield* sql`SELECT * FROM scheduled_wakeups WHERE channel_id = ${channelId}
      AND (expires_at IS NULL OR expires_at > ${now})
      ORDER BY next_run_at, id`.pipe(Effect.flatMap(decodeRows), storeError("list"));
  });

  const cancel = Effect.fn("Schedules.cancel")(function* (channelId: string, id: string) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql`DELETE FROM scheduled_wakeups
      WHERE channel_id = ${channelId} AND id = ${id}
      AND (expires_at IS NULL OR expires_at > ${now}) RETURNING *`.pipe(
      Effect.flatMap(decodeRows),
      storeError("cancel"),
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
    const decoded = yield* Schema.decodeEffect(UpdateInput)(input).pipe(Effect.orDie);

    if (
      decoded.description === undefined &&
      decoded.note === undefined &&
      decoded.expiresAt === undefined &&
      decoded.timing === undefined
    ) {
      return yield* invalid("Provide at least one field to update.");
    }

    const description =
      decoded.description === undefined
        ? undefined
        : yield* validateDescription(decoded.description);
    const note = decoded.note?.trim();

    if (note === "") {
      return yield* invalid("A self-contained note is required.");
    }

    const expiration =
      decoded.expiresAt == null ? decoded.expiresAt : yield* parseTimestamp(decoded.expiresAt);
    const replacedFields: ReplacedField[] = [];
    if (decoded.description !== undefined) replacedFields.push("description");
    if (decoded.timing !== undefined) replacedFields.push("timing");
    if (decoded.note !== undefined) replacedFields.push("note");
    if (decoded.expiresAt !== undefined) replacedFields.push("expiresAt");

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
          const expiresAt = expiration === undefined ? current.expiresAt : expiration;

          if (expiresAt !== null && expiresAt <= Math.max(now, timing.nextRunAt)) {
            return yield* invalid(
              "Expiration must be in the future and after the next occurrence.",
            );
          }

          const updated = {
            ...current,
            ...timing,
            description: description ?? current.description,
            note: note ?? current.note,
            expiresAt,
          };
          const storedRecurrence = recurrenceColumns(updated.recurrence);

          yield* sql`
            UPDATE scheduled_wakeups
            SET description = ${updated.description},
                note = ${updated.note},
                expires_at = ${updated.expiresAt},
                next_run_at = ${updated.nextRunAt},
                cron = ${storedRecurrence.cron},
                timezone = ${storedRecurrence.timezone}
            WHERE channel_id = ${channelId} AND id = ${id}
          `;

          return UpdateResult.make({
            before: current,
            after: updated,
            replacedFields,
          });
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof ValidationError
            ? error
            : new StoreError({
                message: 'Schedules store operation "update" failed',
                operation: "update",
                cause: error,
              }),
        ),
      );
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
              const next = yield* nextCron(
                wakeup.recurrence.expression,
                wakeup.recurrence.timezone,
                now,
              );
              if (wakeup.expiresAt !== null && next >= wakeup.expiresAt) {
                yield* sql`DELETE FROM scheduled_wakeups WHERE id = ${wakeup.id}`;
              } else {
                yield* sql`UPDATE scheduled_wakeups SET next_run_at = ${next} WHERE id = ${wakeup.id}`;
              }
            }
          }

          return due;
        }),
      )
      .pipe(storeError("takeDue"));
  });

  return Service.of({ create, list, cancel, update, takeDue });
});

export interface Interface {
  readonly create: (
    channelId: string,
    input: CreateInput,
  ) => Effect.Effect<Wakeup, ValidationError | StoreError>;
  readonly list: (channelId: string) => Effect.Effect<ReadonlyArray<Wakeup>, StoreError>;
  readonly cancel: (
    channelId: string,
    id: string,
  ) => Effect.Effect<Wakeup, ValidationError | StoreError>;
  readonly update: (
    channelId: string,
    id: string,
    input: UpdateInput,
  ) => Effect.Effect<UpdateResult, ValidationError | StoreError>;
  readonly takeDue: (now: number) => Effect.Effect<ReadonlyArray<Wakeup>, StoreError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "bubblebuddy/scheduling/Schedules",
) {}

export const layer = Layer.effect(Service, makeSchedules);

export * as Schedules from "./schedules.ts";
