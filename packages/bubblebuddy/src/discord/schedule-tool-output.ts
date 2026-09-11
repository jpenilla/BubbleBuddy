import { ContainerBuilder, TextDisplayBuilder, time, TimestampStyles } from "discord.js";
import { Effect, Option, Schema } from "effect";
import { Schedules } from "../scheduling/schedules.ts";
import { inlineCode } from "../shared/markdown.ts";
import { collapseWhitespace, truncate } from "../shared/text.ts";
import { ScheduleTools } from "./tools/schedules.ts";
import type { ToolOutput } from "./tool-output.ts";
import { EMBED_COLOR } from "./utils.ts";

const decodeCreate = Schema.decodeUnknownOption(Schema.Struct({ description: Schema.String }));
const decodeExisting = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));
const decodeResult = Schema.decodeUnknownEffect(Schema.Struct({ details: ScheduleTools.Details }));

const formatTimestamp = (milliseconds: number): string =>
  time(new Date(milliseconds), TimestampStyles.ShortDateMediumTime);

// Generous versus a real cron expression, so a truncation almost never triggers.
const CRON_EXPRESSION_LIMIT = 240;

const formatTiming = (schedule: Schedules.Wakeup): string =>
  Schedules.Recurrence.match(schedule.recurrence, {
    once: () => `Once at ${formatTimestamp(schedule.nextRunAt)}`,
    cron: ({ expression, timezone, expiresAt }) =>
      `Cron ${inlineCode(truncate(expression, CRON_EXPRESSION_LIMIT))} (${inlineCode(timezone)}); next ${formatTimestamp(schedule.nextRunAt)}; ${expiresAt === null ? "no end date" : `ends ${formatTimestamp(expiresAt)}`}`,
  });

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
  detail("Timing", transition(formatTiming(update.before), formatTiming(update.after))),
  ...(update.before.note === update.after.note ? [] : [detail("Instructions", "Replaced")]),
];

const card = (title: string, color: number, details: TextDisplayBuilder[]) =>
  new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title), ...details);

const identification = (label: string, value: string | undefined) =>
  value === undefined || value === ""
    ? []
    : [detail(label, inlineCode(boundIdentification(value)))];

// At most 480 code units after escaping, leaving ample room for card markup.
// Start events contain raw arguments, even when tool validation later fails.
const boundIdentification = (value: string): string => truncate(collapseWhitespace(value), 240);

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
