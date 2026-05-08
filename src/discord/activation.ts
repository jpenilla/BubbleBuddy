import { Events, type Client, type Message } from "discord.js";
import { Effect, Layer } from "effect";

import { ChannelRuntimes, type ChannelRuntimesShape } from "../channel-runtimes.ts";
import { Discord } from "./client.ts";
import { createPromptContext, isGuildTextChannel } from "./utils.ts";

export interface ActivationContext {
  readonly mentionsBot: boolean;
  readonly isReplyToBot: boolean;
}

export const isActivationMessage = (context: ActivationContext): boolean =>
  context.mentionsBot || context.isReplyToBot;

const isReplyToBot = async (message: Message<true>, botUserId: string): Promise<boolean> => {
  if (message.reference?.messageId === undefined) {
    return false;
  }

  try {
    const referencedMessage = await message.fetchReference();
    return referencedMessage.author.id === botUserId;
  } catch {
    return false;
  }
};

export const checkGuildMessageActivation = async (
  message: Message<true>,
  botUserId: string,
): Promise<ActivationContext> => ({
  isReplyToBot: await isReplyToBot(message, botUserId),
  mentionsBot: message.mentions.has(botUserId),
});

export const ActivationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const discord = yield* Discord;
    yield* discord.events.forkOn(Events.MessageCreate, (message) =>
      Effect.gen(function* () {
        if (!message.inGuild()) {
          return;
        }

        const sessions = yield* ChannelRuntimes;
        return yield* Effect.scoped(handleGuildMessage(discord.client, sessions, message));
      }),
    );
  }),
);

const handleGuildMessage = (
  client: Client<true>,
  sessions: ChannelRuntimesShape,
  message: Message<true>,
) =>
  Effect.gen(function* () {
    if (!isGuildTextChannel(message.channel)) {
      return;
    }

    // Avoid infinite reply loop to self (mostly happens when the bot ping leaks into thinking messages)
    if (message.author.id === client.user.id) {
      return;
    }

    const activation = yield* Effect.tryPromise(() =>
      checkGuildMessageActivation(message, client.user.id),
    );
    if (!isActivationMessage(activation)) {
      return;
    }

    const runtime = yield* sessions.get(message.channel.id);
    yield* runtime.activate({
      channel: message.channel,
      originMessage: message,
      promptContext: createPromptContext(client, message.channel, message.guild.name),
    });
  });
