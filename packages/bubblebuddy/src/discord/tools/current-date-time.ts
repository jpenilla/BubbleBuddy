import { Clock, Effect } from "effect";
import { Type } from "typebox";

import { defineEffectTool } from "../../pi/effect-tool.ts";

export const currentDateTimeTool = defineEffectTool({
  name: "current_date_time",
  label: "Current Date & Time",
  description: "Get the current date and time.",
  parameters: Type.Object({}),
  execute: () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return {
        content: [{ type: "text" as const, text: new Date(now).toISOString() }],
        details: undefined,
      };
    }),
});
