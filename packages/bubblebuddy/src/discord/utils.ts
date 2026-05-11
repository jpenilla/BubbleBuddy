import type {
  Client,
  GuildTextBasedChannel,
  Message,
  MessageMentionOptions,
  ReplyOptions,
} from "discord.js";
import type { EmbedBuilder } from "discord.js";

import type { PromptTemplateContext } from "../prompt/system-prompt.ts";
import { splitDiscordMessage } from "../prompt/text.ts";

export const isGuildTextChannel = (channel: unknown): channel is GuildTextBasedChannel =>
  typeof channel === "object" &&
  channel !== null &&
  "isSendable" in channel &&
  typeof channel.isSendable === "function" &&
  channel.isSendable();

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

export const sendOrEditStatusCard = async (
  channel: GuildTextBasedChannel,
  existing: Message<true> | undefined,
  embed: EmbedBuilder,
): Promise<Message<true>> => {
  if (existing !== undefined) {
    await existing.edit({ embeds: [embed] });
    return existing;
  }

  return await channel.send({ embeds: [embed] });
};

export const sendChunkedMessage = async (opts: {
  channel: GuildTextBasedChannel;
  content: string;
  reply?: ReplyOptions;
  allowedMentions?: MessageMentionOptions;
}): Promise<void> => {
  const chunks = splitDiscordMessage(opts.content);

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0 && opts.reply !== undefined) {
      await opts.channel.send({
        content: chunk,
        reply: opts.reply,
        allowedMentions: opts.allowedMentions,
      });
      continue;
    }

    await opts.channel.send({
      content: chunk,
      allowedMentions: opts.allowedMentions,
    });
  }
};
