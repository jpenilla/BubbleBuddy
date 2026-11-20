import { lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { Effect, Schema } from "effect";

import { defineEffectTool } from "../../pi/effect-tool.ts";
import { Schedules } from "../../scheduling/schedules.ts";
import { DiscordToolContext } from "../tool-context.ts";

export const CreatedDetails = Schema.TaggedStruct("Created", {
  schedule: Schedules.Wakeup,
});
export const UpdatedDetails = Schema.TaggedStruct("Updated", {
  update: Schedules.UpdateResult,
});
export const CancelledDetails = Schema.TaggedStruct("Cancelled", {
  schedule: Schedules.Wakeup,
});
export const Details = Schema.Union([CreatedDetails, UpdatedDetails, CancelledDetails]).pipe(
  Schema.toTaggedUnion("_tag"),
);
export type Details = typeof Details.Type;

const description = str({
  minLength: 1,
  maxLength: 120,
  description: "Short task summary.",
});

const note = str({
  minLength: 1,
  description:
    "Complete instructions a fresh session can act on, including relevant user/message IDs.",
});

const expiresAt = str({
  description: "End date as an ISO timestamp with UTC offset. Omit to repeat indefinitely.",
});

const timing = union([
  obj({ kind: lit("after"), seconds: num({ exclusiveMinimum: 0 }) }),
  obj({
    kind: lit("at"),
    timestamp: str({ description: "ISO timestamp with explicit UTC offset" }),
  }),
  obj({
    kind: lit("cron"),
    expression: str({
      description: "Cron expression. Must not repeat more often than once a minute.",
    }),
    timezone: str({ description: "Timezone, e.g. America/New_York or UTC" }),
    expiresAt: opt(expiresAt),
  }),
  obj({
    kind: lit("interval"),
    everySeconds: num({
      minimum: 60,
      description: "Seconds between wakeups; fractions supported to millisecond precision.",
    }),
    anchorAt: opt(
      str({
        description: "ISO timestamp with UTC offset. Omit to anchor at creation/update time.",
      }),
    ),
    expiresAt: opt(expiresAt),
  }),
]);

export const create = defineEffectTool({
  name: "create_schedule",
  description:
    "Schedule a wakeup in this channel. Survives new sessions and restarts. Displays a confirmation card in this channel. Each recurrence triggers a separate wakeup automatically; do not use sleep or time-checking loops to wait for subsequent occurrences.",
  parameters: obj({
    description,
    note,
    timing,
  }),
  replay: "unsafe",
  execute: (input) =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      const schedule = yield* schedules.create(channel.id, input);
      return {
        output: [
          { type: "text" as const, text: `Schedule created:\n\n${Schedules.describe(schedule)}` },
        ],
        details: CreatedDetails.make({ schedule }),
      };
    }).pipe(Effect.catchTag("Schedules.StoreError", (error) => Effect.die(error))),
});

export const update = defineEffectTool({
  name: "update_schedule",
  description:
    "Update a schedule in this channel. Omitted fields stay unchanged. Supplied timing replaces the full timing configuration and recalculates from now. Displays a confirmation card in this channel.",
  parameters: obj({
    id: str(),
    timing: opt(timing),
    description: opt(description),
    note: opt(note),
  }),
  replay: "unsafe",
  execute: (input) =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      const { id, ...fields } = input;
      const updated = yield* schedules.update(channel.id, id, fields);

      return {
        output: [
          {
            type: "text" as const,
            text: `Schedule updated (current state):\n\n${Schedules.describe(updated.after)}`,
          },
        ],
        details: UpdatedDetails.make({ update: updated }),
      };
    }).pipe(Effect.catchTag("Schedules.StoreError", (error) => Effect.die(error))),
});

const NOTE_TERMINATOR = "<<<END_NOTE>>>";

export const list = defineEffectTool({
  name: "list_schedules",
  description:
    "List this channel’s active schedules. Results aren’t shown to the user; summarize them when asked.",
  parameters: obj({}),
  replay: "safe",
  execute: () =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      const active = yield* schedules.list(channel.id);
      return {
        output: [
          {
            type: "text" as const,
            text:
              active.length === 0
                ? "No active schedules."
                : active
                    .map((wakeup) => `${Schedules.describe(wakeup)}\n${NOTE_TERMINATOR}`)
                    .join("\n\n"),
          },
        ],
      };
    }).pipe(Effect.catchTag("Schedules.StoreError", (error) => Effect.die(error))),
});

export const cancel = defineEffectTool({
  name: "cancel_schedule",
  description:
    "Cancel a schedule in this channel. In-flight wakeups are unaffected. Displays a confirmation card in this channel.",
  parameters: obj({ id: str() }),
  replay: "unsafe",
  execute: (input) =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      const schedule = yield* schedules.cancel(channel.id, input.id);
      return {
        output: [
          {
            type: "text" as const,
            text: `Schedule cancelled (removed from active schedules):\n\n${Schedules.describe(schedule)}`,
          },
        ],
        details: CancelledDetails.make({ schedule }),
      };
    }).pipe(Effect.catchTag("Schedules.StoreError", (error) => Effect.die(error))),
});

export * as ScheduleTools from "./schedules.ts";
