import { DateTime, Effect } from "effect";
import { Type } from "typebox";

import { defineEffectTool } from "../../pi/effect-tool.ts";

export const currentDateTimeTool = defineEffectTool({
  name: "current_date_time",
  label: "Current Date & Time",
  description: "Get the current date and time.",
  parameters: Type.Object({}),
  execute: () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `unix_seconds: ${DateTime.toEpochSeconds(now)}`,
              `iso_utc: ${DateTime.formatIso(now)}`,
              `human_utc: ${DateTime.formatUtc(now, {
                locale: "en-US",
                dateStyle: "full",
                timeStyle: "long",
              })}`,
            ].join("\n"),
          },
        ],
        details: undefined,
      };
    }),
});
