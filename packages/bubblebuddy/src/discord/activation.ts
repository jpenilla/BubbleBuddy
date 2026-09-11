import { Events, type Client, type Message } from "discord.js";
import { Effect, Layer } from "effect";

import { ChannelSessions } from "../session/registry.ts";
import { Discord } from "./client.ts";
import { isGuildTextChannel } from "./utils.ts";
import { createPromptContext, formatMessageForPrompt } from "./prompt-formatting.ts";

export const ActivationLayer = Layer.effectDiscard(
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

    const sessions = yield* ChannelSessions;
    const session = yield* sessions.get(message.channel.id);
    yield* session.activate({
      channel: message.channel,
      prompt: formatMessageForPrompt(message),
      promptContext: createPromptContext(client, message.channel, message.guild.name),
    });
  });
