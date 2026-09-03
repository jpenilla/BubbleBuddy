import { Events, Routes, type Client, type Message } from "discord.js";
import { Effect, Layer } from "effect";

import { ChannelSessions } from "../session/registry.ts";
import { Discord } from "./client.ts";
import { isGuildTextChannel, tryDiscordJsPromise } from "./utils.ts";
import { createPromptContext } from "./prompt-formatting.ts";

export const ActivationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const discord = yield* Discord;
    yield* discord.events.forkOn(Events.MessageCreate, (message) =>
      Effect.gen(function* () {
        if (!message.inGuild()) {
          return;
        }

        return yield* Effect.scoped(handleGuildMessage(discord.client, message));
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

    if (!message.mentions.has(client.user.id)) {
      return;
    }

    yield* tryDiscordJsPromise((signal) =>
      message.channel.client.rest.post(Routes.channelTyping(message.channel.id), { signal }),
    ).pipe(
      Effect.timeout("3 seconds"),
      Effect.ignore({
        log: "Warn",
        message: `Failed to send eager typing indicator for channel ${message.channel.id}`,
      }),
      Effect.forkDetach({ startImmediately: true }),
    );

    const sessions = yield* ChannelSessions;
    const session = yield* sessions.get(message.channel.id);
    yield* session.activate({
      channel: message.channel,
      originMessage: message,
      promptContext: createPromptContext(client, message.channel, message.guild.name),
    });
  });
