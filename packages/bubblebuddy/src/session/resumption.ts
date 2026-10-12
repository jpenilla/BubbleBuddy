import { Cause, Effect, Layer } from "effect";

import { DiscordClient } from "../discord/discord-client.ts";
import { isGuildTextChannel, tryDiscordJsPromise } from "../discord/utils.ts";
import { ChannelSessions } from "./registry.ts";

/** Continues sessions left with unfinished work by the last run of the bot. */
export const SessionResumptionLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sessions = yield* ChannelSessions.Service;
    const client = yield* DiscordClient.Service;

    const resume = Effect.fnUntraced(
      function* (channelId: string) {
        const channel = yield* tryDiscordJsPromise(() => client.channels.fetch(channelId));
        if (channel === null || !isGuildTextChannel(channel)) {
          yield* Effect.logWarning("Channel with a session to resume is unavailable");
          return;
        }
        const session = yield* sessions.get(channel.id);
        yield* Effect.logInfo("Resuming session");
        yield* session.resume(channel);
      },
      (effect, channelId) =>
        effect.pipe(
          Effect.scoped,
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.logDebug("Session resumption interrupted", cause)
              : Effect.logError("Session resumption failed", cause),
          ),
          Effect.annotateLogs({ channelId }),
          Effect.withSpan("SessionResumption.resume", { root: true, attributes: { channelId } }),
          Effect.ignoreCause(),
        ),
    );

    const channelIds = yield* sessions.resumable;
    yield* Effect.forkScoped(Effect.forEach(channelIds, resume, { concurrency: 3, discard: true }));
  }),
);
