import { DateTime, Effect, Option } from "effect";
import { Type } from "typebox";

import { AgentToolError, defineEffectTool } from "../../pi/effect-tool.ts";

export const currentDateTimeTool = defineEffectTool({
  name: "current_date_time",
  label: "Current Date & Time",
  description: "Get the current date and time in UTC and optionally in named timezones.",
  parameters: Type.Object({
    timezones: Type.Optional(
      Type.Array(Type.String({ description: "IANA timezone, e.g. America/New_York" })),
    ),
  }),
  execute: (_id, { timezones }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const sections = [
        `UTC\nISO: ${DateTime.formatIso(now)}\nHuman: ${DateTime.formatUtc(now, {
          locale: "en-US",
          dateStyle: "full",
          timeStyle: "long",
        })}`,
      ];
      if (timezones !== undefined) {
        for (const timezone of new Set(timezones)) {
          if (timezone === "UTC") continue;
          const zoned = DateTime.setZoneNamed(now, timezone);
          if (Option.isNone(zoned)) {
            return yield* new AgentToolError({ message: `Invalid timezone: ${timezone}` });
          }
          sections.push(
            `${timezone}\nISO: ${DateTime.formatIsoZoned(zoned.value)}\nHuman: ${DateTime.format(
              zoned.value,
              {
                locale: "en-US",
                dateStyle: "full",
                timeStyle: "long",
              },
            )}`,
          );
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `unix_seconds: ${DateTime.toEpochSeconds(now)}\n\n${sections.join("\n\n")}`,
          },
        ],
        details: undefined,
      };
    }),
});
