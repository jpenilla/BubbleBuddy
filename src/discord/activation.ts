import { Events, type Client, type Message } from "discord.js";
import { Effect, Layer } from "effect";

import { ChannelSessions, type ChannelSessionManager } from "../sessions.ts";
import { Discord } from "./client.ts";
import { createPromptContext, isGuildTextChannel } from "./utils.ts";
import { formatMessageForPrompt } from "./message-formatting.ts";

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

        const sessions = yield* ChannelSessions;
        return yield* handleGuildMessage(discord.client, sessions, message);
      }),
    );
  }),
);

const handleGuildMessage = (
  client: Client<true>,
  sessions: ChannelSessionManager,
  message: Message<true>,
) =>
  Effect.tryPromise(async () => {
    if (!isGuildTextChannel(message.channel)) {
      return;
    }

    // Avoid infinite reply loop to self (mostly happens when the bot ping leaks into thinking messages)
    if (message.author.id === client.user.id) {
      return;
    }

    const activation = await checkGuildMessageActivation(message, client.user.id);
    if (!isActivationMessage(activation)) {
      return;
    }

    const normalizedContent = formatMessageForPrompt(message);
    await sessions.activate(
      {
        channel: message.channel,
        originMessage: message,
        promptContext: createPromptContext(client, message.channel, message.guild.name),
      },
      normalizedContent,
    );
  });
