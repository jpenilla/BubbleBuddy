import type { Client, GuildTextBasedChannel } from "discord.js";

import type { PromptTemplateContext } from "../domain/prompt.ts";

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
