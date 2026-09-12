import { Cause, Clock, Effect, Layer, Schedule } from "effect";
import { Schedules } from "../scheduling/schedules.ts";
import { ChannelSessions } from "../session/registry.ts";
import { DiscordClient } from "./discord-client.ts";
import { isGuildTextChannel, tryDiscordJsPromise } from "./utils.ts";

export const ScheduledWakeupsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const schedules = yield* Schedules.Service;
    const sessions = yield* ChannelSessions;
    const client = yield* DiscordClient.Service;

    const dispatch = Effect.fn("ScheduledWakeups.dispatch")(
      function* (wakeup: Schedules.Wakeup) {
        const attributes = { channelId: wakeup.channelId, scheduleId: wakeup.id };
        yield* Effect.annotateCurrentSpan(attributes);
        const channel = yield* tryDiscordJsPromise(() => client.channels.fetch(wakeup.channelId));
        if (channel === null || !isGuildTextChannel(channel)) {
          yield* Effect.logWarning("Scheduled wakeup destination is unavailable").pipe(
            Effect.annotateLogs(attributes),
          );
          return;
        }
        const session = yield* sessions.get(channel.id);
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.logInfo("Executing scheduled wakeup").pipe(Effect.annotateLogs(attributes));
        yield* session.activate({
          channel,
          prompt: `Current time: ${new Date(now).toISOString()}\n\n${Schedules.describe(wakeup)}`,
        });
      },
      Effect.scoped,
      (effect, wakeup) =>
        effect.pipe(
          Effect.onError((cause) =>
            (Cause.hasInterruptsOnly(cause)
              ? Effect.logDebug("Scheduled wakeup interrupted", cause)
              : Effect.logError("Scheduled wakeup failed", cause)
            ).pipe(Effect.annotateLogs({ channelId: wakeup.channelId, scheduleId: wakeup.id })),
          ),
        ),
    );

    const runPass = Effect.gen(function* () {
      const due = yield* schedules.takeDue(yield* Clock.currentTimeMillis);
      yield* Effect.forEach(
        due,
        (wakeup) => dispatch(wakeup).pipe(Effect.ignoreCause(), Effect.forkScoped),
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
