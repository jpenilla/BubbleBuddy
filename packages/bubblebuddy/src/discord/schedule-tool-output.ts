import { ContainerBuilder, TextDisplayBuilder, time, TimestampStyles } from "discord.js";
import { Effect, Option, Schema } from "effect";
import { Schedules } from "../scheduling/schedules.ts";
import { inlineCode } from "../shared/markdown.ts";
import { collapseWhitespace, truncate } from "../shared/text.ts";
import { ScheduleTools } from "./tools/schedules.ts";
import type { ToolOutput } from "./tool-output.ts";
import { EMBED_COLOR } from "./utils.ts";

const formatTimestamp = (milliseconds: number): string =>
  time(new Date(milliseconds), TimestampStyles.ShortDateMediumTime);

// Generous versus a real cron expression, so a truncation almost never triggers.
const CRON_EXPRESSION_LIMIT = 240;

const recurrenceEmoji = (recurrence: Schedules.Recurrence): string =>
  Schedules.Recurrence.match(recurrence, {
    once: () => "🎯",
    cron: () => "🔁",
  });

const formatTimingBody = (schedule: Schedules.Wakeup): string =>
  Schedules.Recurrence.match(schedule.recurrence, {
    once: () => `Once at ${formatTimestamp(schedule.nextRunAt)}`,
    cron: ({ expression, timezone, expiresAt }) =>
      `Cron ${inlineCode(truncate(expression, CRON_EXPRESSION_LIMIT))} (${inlineCode(timezone)}); next ${formatTimestamp(schedule.nextRunAt)}; ${expiresAt === null ? "no end date" : `ends ${formatTimestamp(expiresAt)}`}`,
  });

const formatTiming = (schedule: Schedules.Wakeup): string =>
  `${recurrenceEmoji(schedule.recurrence)} ${formatTimingBody(schedule)}`;

// Prints `→` only when something differs, and drops the right marker unless the recurrence kind changed.
const transitionTiming = (before: Schedules.Wakeup, after: Schedules.Wakeup): string => {
  const beforeTiming = formatTiming(before);
  const afterBody = formatTimingBody(after);
  const afterTiming = `${recurrenceEmoji(after.recurrence)} ${afterBody}`;
  if (beforeTiming === afterTiming) return beforeTiming;
  return recurrenceEmoji(before.recurrence) === recurrenceEmoji(after.recurrence)
    ? `${beforeTiming} → ${afterBody}`
    : `${beforeTiming} → ${afterTiming}`;
};

const detail = (label: string, value: string): TextDisplayBuilder =>
  new TextDisplayBuilder().setContent(`**${label}**\n${value}`);

const unchangedDetails = (schedule: Schedules.Wakeup): TextDisplayBuilder[] => [
  detail("Description", inlineCode(schedule.description)),
  detail("Timing", formatTiming(schedule)),
];

const transition = (before: string, after: string): string =>
  before === after ? after : `${before} → ${after}`;

const updateDetails = (update: Schedules.UpdateResult): TextDisplayBuilder[] => [
  detail(
    "Description",
    transition(inlineCode(update.before.description), inlineCode(update.after.description)),
  ),
  detail("Timing", transitionTiming(update.before, update.after)),
  ...(update.before.note === update.after.note ? [] : [detail("Instructions", "Replaced")]),
];

const card = (title: string, color: number, details: TextDisplayBuilder[]) =>
  new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title), ...details);

const decodeCreate = Schema.decodeUnknownOption(Schema.Struct({ description: Schema.String }));
const decodeExisting = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));
const decodeResult = Schema.decodeUnknownEffect(Schema.Struct({ details: ScheduleTools.Details }));

// Start events contain raw arguments, even when tool validation later fails, so bound what we echo back.
const IDENTIFICATION_LIMIT = 240;

const identification = (
  label: string,
  value: string | undefined,
): TextDisplayBuilder | undefined =>
  value === undefined || value === ""
    ? undefined
    : detail(label, inlineCode(truncate(collapseWhitespace(value), IDENTIFICATION_LIMIT)));

const existingIdentification = (args: unknown) =>
  identification("Schedule ID", Option.getOrUndefined(decodeExisting(args))?.id);

const renderSuccess = (details: ScheduleTools.Details) =>
  ScheduleTools.Details.match(details, {
    Created: ({ schedule }) =>
      card("⏰ ✅ **Schedule created**", EMBED_COLOR.success, unchangedDetails(schedule)),
    Updated: ({ update }) =>
      card("⏰ ✅ **Schedule updated**", EMBED_COLOR.success, updateDetails(update)),
    Cancelled: ({ schedule }) =>
      card("⏰ ✅ **Schedule cancelled**", EMBED_COLOR.success, unchangedDetails(schedule)),
  });

const formatter = (options: {
  readonly pendingTitle: string;
  readonly failedTitle: string;
  readonly identify: (args: unknown) => TextDisplayBuilder | undefined;
}): ToolOutput.StandaloneFormatter => ({
  begin: (event) => {
    const identified = options.identify(event.args);
    const details = identified === undefined ? [] : [identified];
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
  pendingTitle: "⏰ ⏳ **Creating schedule**",
  failedTitle: "⏰ ❌ **Could not create schedule**",
  identify: (args) =>
    identification("Schedule", Option.getOrUndefined(decodeCreate(args))?.description),
});

export const update = formatter({
  pendingTitle: "⏰ ⏳ **Updating schedule**",
  failedTitle: "⏰ ❌ **Could not update schedule**",
  identify: existingIdentification,
});

export const cancel = formatter({
  pendingTitle: "⏰ ⏳ **Cancelling schedule**",
  failedTitle: "⏰ ❌ **Could not cancel schedule**",
  identify: existingIdentification,
});

export * as ScheduleToolOutput from "./schedule-tool-output.ts";
