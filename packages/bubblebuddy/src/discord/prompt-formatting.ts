import { type Client, type GuildTextBasedChannel, Message } from "discord.js";

import type { PromptTemplateContext } from "../prompt/system-prompt.ts";

export const DISCORD_SAFE_MESSAGE_LIMIT = 1_900;

export const createPromptContext = (
  client: Client<true>,
  channel: GuildTextBasedChannel,
  guildName: string,
): PromptTemplateContext => ({
  botName: client.user.username,
  channelName:
    "name" in channel && typeof channel.name === "string" ? channel.name : "unknown-channel",
  channelStatusText:
    "topic" in channel && typeof channel.topic === "string"
      ? channel.topic.trim().length > 0
        ? channel.topic.trim()
        : "none"
      : "none",
  guildName,
});

export const formatDiscordUserReference = (username: string, userId: string): string =>
  `@${username} mention=<@${userId}>`;

export const normalizeIncomingUserMentions = (
  content: string,
  usernamesById: ReadonlyMap<string, string>,
): string => {
  let normalized = content;

  for (const [id, username] of usernamesById.entries()) {
    const reference = formatDiscordUserReference(username, id);
    normalized = normalized.replaceAll(`<@${id}>`, reference);
    normalized = normalized.replaceAll(`<@!${id}>`, reference);
  }

  return normalized;
};

export const formatMessageForPrompt = (message: Message<true>): string =>
  formatIncomingDiscordMessage(
    message.id,
    message.author.username,
    message.author.id,
    message.content,
    new Map([...message.mentions.users.values()].map((user) => [user.id, user.username])),
    message.reference?.messageId ?? undefined,
  );

export const formatIncomingDiscordMessage = (
  messageId: string,
  authorUsername: string,
  authorId: string,
  content: string,
  usernamesById: ReadonlyMap<string, string>,
  inReplyToMessageId?: string,
): string => {
  const normalizedContent = normalizeIncomingUserMentions(content, usernamesById).trim();
  const replyReference = inReplyToMessageId !== undefined ? ` reply_to=${inReplyToMessageId}` : "";
  const prefix = `[msg ${messageId} user=${authorUsername} mention=<@${authorId}>${replyReference}]`;
  return normalizedContent.length === 0 ? prefix : `${prefix} ${normalizedContent}`;
};
