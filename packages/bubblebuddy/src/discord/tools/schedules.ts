import { Effect, Schema } from "effect";
import { Type } from "typebox";

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

const description = Type.String({
  minLength: 1,
  maxLength: 120,
  description: "Short task summary.",
});

const note = Type.String({
  minLength: 1,
  description:
    "Complete instructions a fresh session can act on, including relevant user/message IDs.",
});

const expiresAt = Type.String({
  description: "End date as an ISO timestamp with UTC offset. Omit to repeat indefinitely.",
});

const timing = Type.Union([
  Type.Object({ kind: Type.Literal("after"), seconds: Type.Number({ exclusiveMinimum: 0 }) }),
  Type.Object({
    kind: Type.Literal("at"),
    timestamp: Type.String({ description: "ISO timestamp with explicit UTC offset" }),
  }),
  Type.Object({
    kind: Type.Literal("cron"),
    expression: Type.String({
      description: "Cron expression. Must not repeat more often than once a minute.",
    }),
    timezone: Type.String({ description: "Timezone, e.g. America/New_York or UTC" }),
    expiresAt: Type.Optional(expiresAt),
  }),
]);

export const create = defineEffectTool({
  name: "create_schedule",
  label: "Create schedule",
  description:
    "Schedule a wakeup in this channel. Survives new sessions and restarts. Displays a confirmation card in this channel.",
  parameters: Type.Object({
    description,
    note,
    timing,
  }),
  execute: (_id, input) =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      const schedule = yield* schedules.create(channel.id, input);
      return {
        content: [{ type: "text" as const, text: Schedules.describe(schedule) }],
        details: CreatedDetails.make({ schedule }),
      };
    }).pipe(Effect.catchTag("StoreError", (error) => Effect.die(error))),
});

export const update = defineEffectTool({
  name: "update_schedule",
  label: "Update schedule",
  description:
    "Update a schedule in this channel. Omitted fields stay unchanged. Supplied timing replaces the full timing configuration and recalculates from now. Displays a confirmation card in this channel.",
  parameters: Type.Object({
    id: Type.String(),
    timing: Type.Optional(timing),
    description: Type.Optional(description),
    note: Type.Optional(note),
  }),
  execute: (_id, input) =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      const { id, ...fields } = input;
      const updated = yield* schedules.update(channel.id, id, fields);

      return {
        content: [{ type: "text" as const, text: Schedules.describe(updated.after) }],
        details: UpdatedDetails.make({ update: updated }),
      };
    }).pipe(Effect.catchTag("StoreError", (error) => Effect.die(error))),
});

const NOTE_TERMINATOR = "<<<END_NOTE>>>";

export const list = defineEffectTool({
  name: "list_schedules",
  label: "List schedules",
  description:
    "List this channel’s active schedules. Results aren’t shown to the user; summarize them when asked.",
  parameters: Type.Object({}),
  execute: () =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      const active = yield* schedules.list(channel.id);
      return {
        content: [
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
        details: undefined,
      };
    }).pipe(Effect.catchTag("StoreError", (error) => Effect.die(error))),
});

export const cancel = defineEffectTool({
  name: "cancel_schedule",
  label: "Cancel schedule",
  description:
    "Cancel a schedule in this channel. In-flight wakeups are unaffected. Displays a confirmation card in this channel.",
  parameters: Type.Object({ id: Type.String() }),
  execute: (_id, input) =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      const schedule = yield* schedules.cancel(channel.id, input.id);
      return {
        content: [{ type: "text" as const, text: Schedules.describe(schedule) }],
        details: CancelledDetails.make({ schedule }),
      };
    }).pipe(Effect.catchTag("StoreError", (error) => Effect.die(error))),
});

export * as ScheduleTools from "./schedules.ts";
