import { Cause, Clock, Effect, Layer, Stream } from "effect";
import { Schedules } from "../scheduling/schedules.ts";
import { ChannelSessions } from "../session/registry.ts";
import { DiscordClient } from "./discord-client.ts";
import { isGuildTextChannel, tryDiscordJsPromise } from "./utils.ts";

export const ScheduledWakeupsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const schedules = yield* Schedules.Service;
    const sessions = yield* ChannelSessions;
    const client = yield* DiscordClient.Service;

    const dispatch = Effect.fnUntraced(
      function* (wakeup: Schedules.Wakeup) {
        const channel = yield* tryDiscordJsPromise(() => client.channels.fetch(wakeup.channelId));
        if (channel === null || !isGuildTextChannel(channel)) {
          yield* Effect.logWarning("Scheduled wakeup destination is unavailable");
          return;
        }
        const session = yield* sessions.get(channel.id);
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.logInfo("Executing scheduled wakeup");
        yield* session.activate({
          channel,
          prompt: `Current time: ${new Date(now).toISOString()}\n\n${Schedules.describe(wakeup)}`,
        });
      },
      (effect, wakeup) =>
        effect.pipe(
          Effect.scoped,
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.logDebug("Scheduled wakeup interrupted", cause)
              : Effect.logError("Scheduled wakeup failed", cause),
          ),
          Effect.annotateLogs({ channelId: wakeup.channelId, scheduleId: wakeup.id }),
          Effect.withSpan("ScheduledWakeups.dispatch", {
            root: true,
            attributes: { channelId: wakeup.channelId, scheduleId: wakeup.id },
          }),
          Effect.ignoreCause(),
        ),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(schedules.due, (wakeup) => dispatch(wakeup).pipe(Effect.forkScoped)),
    );
  }),
);
