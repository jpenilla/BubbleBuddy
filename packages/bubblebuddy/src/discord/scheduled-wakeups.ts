import { Clock, Effect, Layer, Schedule } from "effect";
import { Schedules } from "../scheduling/schedules.ts";
import { ChannelSessions } from "../session/registry.ts";
import { Discord } from "./client.ts";
import { isGuildTextChannel, tryDiscordJsPromise } from "./utils.ts";

export const ScheduledWakeupsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const schedules = yield* Schedules.Service;
    const sessions = yield* ChannelSessions;
    const discord = yield* Discord;

    const dispatch = Effect.fn("ScheduledWakeups.dispatch")(function* (wakeup: Schedules.Wakeup) {
      const channel = yield* tryDiscordJsPromise(() =>
        discord.client.channels.fetch(wakeup.channelId),
      );
      if (channel === null || !isGuildTextChannel(channel)) {
        yield* Effect.logWarning("Scheduled wakeup destination is unavailable", {
          channelId: wakeup.channelId,
          scheduleId: wakeup.id,
        });
        return;
      }
      const session = yield* sessions.get(channel.id);
      const timing = Schedules.Recurrence.match(wakeup.recurrence, {
        once: () => "once",
        cron: ({ expression, timezone, expiresAt }) =>
          `cron ${expression} (${timezone})${expiresAt === null ? "" : `, ends ${new Date(expiresAt).toISOString()}`}`,
      });
      yield* Effect.logInfo("Executing scheduled wakeup", {
        channelId: channel.id,
        scheduleId: wakeup.id,
      });
      yield* session.activate({
        channel,
        prompt: [
          `Scheduled wakeup: ${wakeup.id}`,
          `Description: ${wakeup.description}`,
          `Timing: ${timing}`,
          `Scheduled for: ${new Date(wakeup.nextRunAt).toISOString()}`,
          "",
          "Note:",
          wakeup.note,
        ].join("\n"),
      });
    }, Effect.scoped);

    const runPass = Effect.gen(function* () {
      const due = yield* schedules.takeDue(yield* Clock.currentTimeMillis);
      yield* Effect.forEach(
        due,
        (wakeup) =>
          dispatch(wakeup).pipe(
            Effect.ignore({ log: "Error", message: `Scheduled wakeup ${wakeup.id} failed` }),
            Effect.forkScoped,
          ),
        { discard: true },
      );
    });

    yield* runPass.pipe(
      Effect.ignore({ log: "Error", message: "Scheduled wakeup polling failed" }),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped,
    );
  }),
);
