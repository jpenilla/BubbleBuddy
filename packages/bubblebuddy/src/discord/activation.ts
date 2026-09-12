import { Events, type Client, type Message } from "discord.js";
import { Effect, Layer } from "effect";

import { ChannelSessions } from "../session/registry.ts";
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

    if (!message.mentions.has(client.user.id)) {
      return;
    }

    const sessions = yield* ChannelSessions;
    const session = yield* sessions.get(message.channel.id);
    yield* session.activate({
      channel: message.channel,
      prompt: formatMessageForPrompt(message),
    });
  });
