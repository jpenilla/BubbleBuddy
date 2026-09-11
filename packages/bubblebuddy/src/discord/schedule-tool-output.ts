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
    cron: ({ expression, timezone, expiresAt }) =>
      `Cron ${code(expression)} (${code(timezone)}); next ${formatTimestamp(schedule.nextRunAt)}; ${expiresAt === null ? "no end date" : `ends ${formatTimestamp(expiresAt)}`}`,
  });

const detail = (label: string, value: string): TextDisplayBuilder =>
  new TextDisplayBuilder().setContent(`**${label}**\n${value}`);

const unchangedDetails = (schedule: Schedules.Wakeup): TextDisplayBuilder[] => [
  detail("Description", code(schedule.description)),
  detail("Timing", formatTiming(schedule)),
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

  return details;
};

const card = (title: string, color: number, details: TextDisplayBuilder[]) =>
  new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title), ...details);

const identification = (label: string, value: string | undefined) =>
  value === undefined || value === "" ? [] : [detail(label, code(boundIdentification(value)))];

// At most 480 code units after escaping, leaving ample room for card markup.
// Start events contain raw arguments, even when tool validation later fails.
const boundIdentification = (value: string): string => {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
};

const existingIdentification = (args: unknown) =>
  identification("Schedule ID", Option.getOrUndefined(decodeExisting(args))?.id);

const renderSuccess = (details: ScheduleTools.Details) =>
  ScheduleTools.Details.match(details, {
    Created: ({ schedule }) =>
      card("✅ **Schedule created**", EMBED_COLOR.success, unchangedDetails(schedule)),
    Updated: ({ update }) =>
      card("✅ **Schedule updated**", EMBED_COLOR.success, updateDetails(update)),
    Cancelled: ({ schedule }) =>
      card("✅ **Schedule cancelled**", EMBED_COLOR.success, unchangedDetails(schedule)),
  });

const formatter = (options: {
  readonly pendingTitle: string;
  readonly failedTitle: string;
  readonly identify: (args: unknown) => TextDisplayBuilder[];
}): ToolOutput.StandaloneFormatter => ({
  begin: (event) => {
    const details = options.identify(event.args);
    return {
      initial: card(options.pendingTitle, EMBED_COLOR.pending, details),
      complete: Effect.fn("ScheduleToolOutput.complete")(function* (end: ToolOutput.EndEvent) {
        if (end.isError) return card(options.failedTitle, EMBED_COLOR.danger, details);
        const result = yield* decodeResult(end.result);
        return renderSuccess(result.details);
      }),
    };
  },
});

export const create = formatter({
  pendingTitle: "⏳ **Creating schedule**",
  failedTitle: "❌ **Could not create schedule**",
  identify: (args) =>
    identification("Schedule", Option.getOrUndefined(decodeCreate(args))?.description),
});

export const update = formatter({
  pendingTitle: "⏳ **Updating schedule**",
  failedTitle: "❌ **Could not update schedule**",
  identify: existingIdentification,
});

export const cancel = formatter({
  pendingTitle: "⏳ **Cancelling schedule**",
  failedTitle: "❌ **Could not cancel schedule**",
  identify: existingIdentification,
});

export * as ScheduleToolOutput from "./schedule-tool-output.ts";
