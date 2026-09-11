import { Effect } from "effect";
import { Type } from "typebox";
import { defineEffectTool } from "../../pi/effect-tool.ts";
import { Schedules } from "../../scheduling/schedules.ts";
import { DiscordToolContext } from "../tool-context.ts";

const describe = (wakeup: Schedules.Wakeup) => ({
  ...wakeup,
  nextRunAt: new Date(wakeup.nextRunAt).toISOString(),
});
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: undefined,
});

export const createScheduleTool = defineEffectTool({
  name: "create_schedule",
  label: "Create schedule",
  description: "Schedule a wakeup in this channel. Survives new sessions and restarts.",
  parameters: Type.Object({
    note: Type.String({
      minLength: 1,
      description: "Instructions a fresh session can act on, including relevant user/message IDs.",
    }),
    timing: Type.Union([
      Type.Object({ kind: Type.Literal("after"), seconds: Type.Number({ exclusiveMinimum: 0 }) }),
      Type.Object({
        kind: Type.Literal("at"),
        timestamp: Type.String({ description: "ISO timestamp with explicit UTC offset" }),
      }),
      Type.Object({
        kind: Type.Literal("cron"),
        expression: Type.String({ description: "Five-field cron (minute precision)" }),
        timezone: Type.String({ description: "Timezone, e.g. America/New_York or UTC" }),
      }),
    ]),
  }),
  execute: (_id, input) =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      return result(describe(yield* schedules.create(channel.id, input)));
    }).pipe(Effect.catchTag("StoreError", (error) => Effect.die(error))),
});

export const listSchedulesTool = defineEffectTool({
  name: "list_schedules",
  label: "List schedules",
  description: "List this channel's schedules.",
  parameters: Type.Object({}),
  execute: () =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      return result((yield* schedules.list(channel.id)).map(describe));
    }).pipe(Effect.catchTag("StoreError", (error) => Effect.die(error))),
});

export const cancelScheduleTool = defineEffectTool({
  name: "cancel_schedule",
  label: "Cancel schedule",
  description: "Cancel a schedule in this channel. In-flight wakeups are unaffected.",
  parameters: Type.Object({ id: Type.String() }),
  execute: (_id, input) =>
    Effect.gen(function* () {
      const { channel } = yield* DiscordToolContext;
      const schedules = yield* Schedules.Service;
      return result({ cancelled: yield* schedules.cancel(channel.id, input.id) });
    }).pipe(Effect.catchTag("StoreError", (error) => Effect.die(error))),
});
