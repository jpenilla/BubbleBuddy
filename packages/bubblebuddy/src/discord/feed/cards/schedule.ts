import { ContainerBuilder, TextDisplayBuilder, time, TimestampStyles } from "discord.js";
import { Duration, Option, Schema } from "effect";

import { Schedules } from "../../../scheduling/schedules.ts";
import { inlineCode } from "../../../shared/markdown.ts";
import { collapseWhitespace, truncate } from "../../../shared/text.ts";
import { ScheduleTools } from "../../tools/schedules.ts";
import { EMBED_COLOR } from "../../utils.ts";
import { type ToolResult } from "../state.ts";

const formatTimestamp = (milliseconds: number): string =>
  // @effect-diagnostics-next-line globalDate:off -- discord.js time() requires a Date.
  time(new Date(milliseconds), TimestampStyles.ShortDateMediumTime);

// Generous versus a real cron expression, so a truncation almost never triggers.
const CRON_EXPRESSION_LIMIT = 240;

const recurrenceEmoji = (recurrence: Schedules.Recurrence): string =>
  Schedules.Recurrence.match(recurrence, {
    once: () => "🎯",
    cron: () => "📅",
    interval: () => "🔁",
  });

const formatTimingBody = (schedule: Schedules.Wakeup): string =>
  Schedules.Recurrence.match(schedule.recurrence, {
    once: () => `Once at ${formatTimestamp(schedule.nextRunAt)}`,
    cron: ({ expression, timezone, expiresAt }) =>
      `Cron ${inlineCode(truncate(expression, CRON_EXPRESSION_LIMIT))} (${inlineCode(timezone)}); next ${formatTimestamp(schedule.nextRunAt)}; ${expiresAt === null ? "no end date" : `ends ${formatTimestamp(expiresAt)}`}`,
    interval: ({ everyMs, anchorAt, expiresAt }) =>
      `Every ${Duration.format(Duration.millis(everyMs))} from ${formatTimestamp(anchorAt)}; next ${formatTimestamp(schedule.nextRunAt)}; ${expiresAt === null ? "no end date" : `ends ${formatTimestamp(expiresAt)}`}`,
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
const decodeDetails = Schema.decodeUnknownOption(ScheduleTools.Details);

// Tool calls carry the model's raw arguments, even when validation later fails, so bound what we echo back.
const IDENTIFICATION_LIMIT = 240;

const identification = (label: string, value: string | undefined): TextDisplayBuilder | undefined =>
  value === undefined || value === ""
    ? undefined
    : detail(label, inlineCode(truncate(collapseWhitespace(value), IDENTIFICATION_LIMIT)));

const existingIdentification = (args: unknown) =>
  identification("Schedule ID", Option.getOrUndefined(decodeExisting(args))?.id);

const successDetails = (details: ScheduleTools.Details) =>
  ScheduleTools.Details.match(details, {
    Created: ({ schedule }) => unchangedDetails(schedule),
    Updated: ({ update }) => updateDetails(update),
    Cancelled: ({ schedule }) => unchangedDetails(schedule),
  });

const formatter =
  (options: {
    readonly pendingTitle: string;
    readonly failedTitle: string;
    readonly succeededTitle: string;
    readonly identify: (args: unknown) => TextDisplayBuilder | undefined;
  }) =>
  (args: unknown, result: ToolResult | undefined) => {
    const identified = options.identify(args);
    const details = identified === undefined ? [] : [identified];
    if (result === undefined) return card(options.pendingTitle, EMBED_COLOR.pending, details);
    if (result.isError) return card(options.failedTitle, EMBED_COLOR.danger, details);
    // A result whose details the card cannot read shows what the call identified.
    return card(
      options.succeededTitle,
      EMBED_COLOR.success,
      Option.match(decodeDetails(result.details), {
        onNone: () => details,
        onSome: successDetails,
      }),
    );
  };

export const create = formatter({
  pendingTitle: "⏳ ⏰ **Creating schedule**",
  failedTitle: "❌ ⏰ **Could not create schedule**",
  succeededTitle: "✅ ⏰ **Schedule created**",
  identify: (args) =>
    identification("Schedule", Option.getOrUndefined(decodeCreate(args))?.description),
});

export const update = formatter({
  pendingTitle: "⏳ ⏰ **Updating schedule**",
  failedTitle: "❌ ⏰ **Could not update schedule**",
  succeededTitle: "✅ ⏰ **Schedule updated**",
  identify: existingIdentification,
});

export const cancel = formatter({
  pendingTitle: "⏳ ⏰ **Cancelling schedule**",
  failedTitle: "❌ ⏰ **Could not cancel schedule**",
  succeededTitle: "✅ ⏰ **Schedule cancelled**",
  identify: existingIdentification,
});

export * as ScheduleCard from "./schedule.ts";
