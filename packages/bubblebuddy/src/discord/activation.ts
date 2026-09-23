import { Events, MessageFlags, type Client, type Message } from "discord.js";
import { Cause, Deferred, Effect, Layer, Option } from "effect";

import { ChannelSessions } from "../session/registry.ts";
import { ChannelSettings } from "../session/settings.ts";
import { DiscordEvents } from "./discord-events.ts";
import { DiscordClient } from "./discord-client.ts";
import { isGuildTextChannel } from "./utils.ts";
import { formatMessageForPrompt } from "./prompt-formatting.ts";

export const ActivationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const client = yield* DiscordClient.Service;
    const events = yield* DiscordEvents.Service;
    yield* events.forkOn(Events.MessageCreate, (message) =>
      Effect.gen(function* () {
        if (!message.inGuild()) {
          return;
        }

        return yield* Effect.scoped(handleGuildMessage(client, message));
      }),
    );
  }),
);

const handleGuildMessage = (client: Client<true>, message: Message<true>) =>
  Effect.gen(function* () {
    if (!isGuildTextChannel(message.channel)) {
      return;
    }

    // Avoid infinite reply loop to self (mostly happens when the bot ping leaks into thinking messages)
    if (message.author.id === client.user.id) {
      return;
    }

    yield* Effect.gen(function* () {
      let resolvedMessage = message;
      if (message.flags.has(MessageFlags.Loading)) {
        resolvedMessage = yield* awaitLoadingResponse(message);
      }

      if (!resolvedMessage.mentions.has(client.user.id)) {
        const settingsService = yield* ChannelSettings.Service;
        const settings = yield* settingsService.get(message.channel.id);
        const replyMode = yield* settings.getReplyMode;
        if (replyMode === "mention-only") {
          return;
        }
      }

      const sessions = yield* ChannelSessions;
      const session = yield* sessions.get(message.channel.id);
      yield* session.activate({
        channel: message.channel,
        prompt: formatMessageForPrompt(resolvedMessage),
      });
    }).pipe(
      Effect.onError((cause) =>
        (Cause.hasInterruptsOnly(cause)
          ? Effect.logDebug("Discord message activation interrupted", cause)
          : Effect.logError("Discord message activation failed", cause)
        ).pipe(
          Effect.annotateLogs({
            channelId: message.channel.id,
            messageId: message.id,
          }),
        ),
      ),
      Effect.withSpan("DiscordActivation.handleMessage", {
        root: true,
        attributes: {
          channelId: message.channel.id,
          messageId: message.id,
        },
      }),
      Effect.annotateSpans({ channelId: message.channel.id }),
      Effect.annotateLogs({ channelId: message.channel.id }),
      Effect.ignoreCause(),
    );
  });

const awaitLoadingResponse = Effect.fn("DiscordActivation.awaitLoadingResponse")(function* (
  message: Message<true>,
) {
  const events = yield* DiscordEvents.Service;
  const updated = yield* Deferred.make<Message<true>>();
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* events.on(Events.MessageUpdate, (_before, after) => {
        if (after.id === message.id && after.inGuild() && !after.flags.has(MessageFlags.Loading)) {
          Deferred.doneUnsafe(updated, Effect.succeed(after));
        }
      });
      // The cached message may have been updated before the listener was registered.
      if (!message.flags.has(MessageFlags.Loading)) return message;
      // Interaction tokens remain valid for 15 minutes: https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-tokens
      return yield* Deferred.await(updated).pipe(
        Effect.timeoutOption("15 minutes"),
        Effect.map(Option.getOrElse(() => message)),
      );
    }),
  );
});
