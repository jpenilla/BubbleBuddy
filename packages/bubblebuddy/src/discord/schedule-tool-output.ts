import { ContainerBuilder, TextDisplayBuilder, time, TimestampStyles } from "discord.js";
import { Effect, Option, Schema } from "effect";
import { Schedules } from "../scheduling/schedules.ts";
import { ScheduleTools } from "./tools/schedules.ts";
import type { ToolOutput } from "./tool-output.ts";
import { EMBED_COLOR } from "./utils.ts";

const decodeCreate = Schema.decodeUnknownOption(Schema.Struct({ description: Schema.String }));
const decodeExisting = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));
const decodeResult = Schema.decodeUnknownEffect(Schema.Struct({ details: ScheduleTools.Details }));

const escapeInlineCode = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");

const code = (value: string): string => `\`${escapeInlineCode(value)}\``;

const formatTimestamp = (milliseconds: number): string =>
  time(new Date(milliseconds), TimestampStyles.ShortDateMediumTime);

const formatTiming = (schedule: Schedules.Wakeup): string =>
  Schedules.Recurrence.match(schedule.recurrence, {
    once: () => `Once at ${formatTimestamp(schedule.nextRunAt)}`,
    cron: ({ expression, timezone }) =>
      `Cron ${code(expression)} (${code(timezone)}); next ${formatTimestamp(schedule.nextRunAt)}`,
  });

const formatExpiration = (expiresAt: number | null): string =>
  expiresAt === null ? "No expiration" : formatTimestamp(expiresAt);

const detail = (label: string, value: string): TextDisplayBuilder =>
  new TextDisplayBuilder().setContent(`**${label}**\n${value}`);

const unchangedDetails = (schedule: Schedules.Wakeup): TextDisplayBuilder[] => [
  detail("Description", code(schedule.description)),
  detail("Timing", formatTiming(schedule)),
  detail("Expiration", formatExpiration(schedule.expiresAt)),
];

const updateDetails = (update: Schedules.UpdateResult): TextDisplayBuilder[] => {
  const details: TextDisplayBuilder[] = [];
  const replaced = new Set(update.replacedFields);

  if (replaced.has("description")) {
    details.push(
      detail(
        "Description",
        `${code(update.before.description)} → ${code(update.after.description)}`,
      ),
    );
  } else {
    details.push(detail("Description", code(update.after.description)));
  }
  if (replaced.has("timing")) {
    details.push(
      detail("Timing", `${formatTiming(update.before)} → ${formatTiming(update.after)}`),
    );
  }
  if (replaced.has("note")) {
    details.push(detail("Instructions", "Replaced"));
  }
  if (replaced.has("expiresAt")) {
    details.push(
      detail(
        "Expiration",
        `${formatExpiration(update.before.expiresAt)} → ${formatExpiration(update.after.expiresAt)}`,
      ),
    );
  }

  return details;
};

const card = (title: string, color: number, details: TextDisplayBuilder[]) =>
  new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title), ...details);

const identification = (label: string, value: string | undefined) =>
  value === undefined || value === "" ? [] : [detail(label, code(value))];

const existingIdentification = (args: unknown) =>
  identification("Schedule ID", Option.getOrUndefined(decodeExisting(args))?.id);

interface Presentation {
  readonly pendingTitle: string;
  readonly failedTitle: string;
  readonly identify: (args: unknown) => TextDisplayBuilder[];
}

const presentations: Readonly<Record<string, Presentation>> = {
  create_schedule: {
    pendingTitle: "⏳ **Creating schedule**",
    failedTitle: "❌ **Could not create schedule**",
    identify: (args: unknown) =>
      identification(
        "Schedule",
        Option.getOrUndefined(decodeCreate(args))?.description.replaceAll(/\s+/g, " ").trim(),
      ),
  },
  update_schedule: {
    pendingTitle: "⏳ **Updating schedule**",
    failedTitle: "❌ **Could not update schedule**",
    identify: existingIdentification,
  },
  cancel_schedule: {
    pendingTitle: "⏳ **Cancelling schedule**",
    failedTitle: "❌ **Could not cancel schedule**",
    identify: existingIdentification,
  },
};

const renderSuccess = (details: ScheduleTools.Details) =>
  ScheduleTools.Details.match(details, {
    Created: ({ schedule }) =>
      card("✅ **Schedule created**", EMBED_COLOR.success, unchangedDetails(schedule)),
    Updated: ({ update }) =>
      card("✅ **Schedule updated**", EMBED_COLOR.success, updateDetails(update)),
    Cancelled: ({ schedule }) =>
      card("✅ **Schedule cancelled**", EMBED_COLOR.success, unchangedDetails(schedule)),
  });

export const formatter: ToolOutput.StandaloneFormatter = {
  begin: (event) => {
    const { pendingTitle, failedTitle, identify } = presentations[event.toolName];
    const details = identify(event.args);
    return {
      initial: card(pendingTitle, EMBED_COLOR.pending, details),
      complete: Effect.fn("ScheduleToolOutput.complete")(function* (end: ToolOutput.EndEvent) {
        if (end.isError) return card(failedTitle, EMBED_COLOR.danger, details);
        const result = yield* decodeResult(end.result);
        return renderSuccess(result.details);
      }),
    };
  },
};

export * as ScheduleToolOutput from "./schedule-tool-output.ts";
