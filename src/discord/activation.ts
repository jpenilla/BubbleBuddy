import type { Message } from "discord.js";

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
