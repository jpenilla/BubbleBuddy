import { Clock, Effect, Layer, Schedule } from "effect";
import { Schedules } from "../scheduling/schedules.ts";
import { ChannelSessions } from "../session/registry.ts";
import { Discord } from "./client.ts";
import { createPromptContext } from "./prompt-formatting.ts";
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
          scheduleId: wakeup.id,
          channelId: wakeup.channelId,
        });
        return;
      }
      const session = yield* sessions.get(channel.id);
      yield* session.activate({
        channel,
        promptContext: createPromptContext(discord.client, channel, channel.guild.name),
        prompt: [
          "Scheduled wakeup (a previously saved instruction, not a new Discord message).",
          `Schedule: ${wakeup.id}`,
          `Scheduled for: ${new Date(wakeup.nextRunAt).toISOString()}`,
          "",
          "Saved note:",
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
          ),
        { concurrency: 3, discard: true },
      );
    });

    yield* runPass.pipe(
      Effect.ignore({ log: "Error", message: "Scheduled wakeup polling failed" }),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped,
    );
  }),
);
