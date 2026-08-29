import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

import type { ChannelStatus } from "../../session/channel.ts";
import { ChannelSessions } from "../../session/registry.ts";
import { isGuildTextChannel, tryDiscordJsPromise } from "../utils.ts";
import { createPromptContext } from "../prompt-formatting.ts";
import { createCommand, inGuildChannel } from "./command.ts";

const formatNumber = (value: number): string => value.toLocaleString();

const formatCost = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const createStatusEmbed = (status: ChannelStatus): EmbedBuilder => {
  const usage = status.stats.contextUsage;
  const usageText = usage
    ? usage.tokens === null
      ? "unknown"
      : `${formatNumber(usage.tokens)}${usage.percent === null ? "" : ` (${Math.round(usage.percent)}%)`}${usage.contextWindow === undefined ? "" : ` / ${formatNumber(usage.contextWindow)}`}`
    : "unknown";

  return new EmbedBuilder()
    .setTitle("Channel status")
    .setColor(0x5865f2)
    .addFields(
      {
        name: "Settings",
        value: `Thinking messages: ${status.showThinking ? "enabled" : "disabled"}`,
        inline: false,
      },
      {
        name: "Model",
        value:
          status.model === undefined
            ? "unknown"
            : [`Provider: ${status.model.provider}`, `Model: ${status.model.name}`].join("\n"),
        inline: false,
      },
      {
        name: "Messages",
        value: [
          `User: ${formatNumber(status.stats.userMessages)}`,
          `Assistant: ${formatNumber(status.stats.assistantMessages)}`,
          `Tools: ${formatNumber(status.stats.toolCalls)} calls / ${formatNumber(status.stats.toolResults)} results`,
          `Total: ${formatNumber(status.stats.totalMessages)}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Tokens",
        value: [
          `Input: ${formatNumber(status.stats.tokens.input)}`,
          `Output: ${formatNumber(status.stats.tokens.output)}`,
          `Cache read/write: ${formatNumber(status.stats.tokens.cacheRead)} / ${formatNumber(status.stats.tokens.cacheWrite)}`,
          `Total: ${formatNumber(status.stats.tokens.total)}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Context & cost",
        value: [`Context: ${usageText}`, `Estimated cost: ${formatCost(status.stats.cost)}`].join(
          "\n",
        ),
        inline: false,
      },
    );
};

export const statusCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show this channel's pi session token, cost, and runtime stats."),
  execute: inGuildChannel(function* (interaction) {
    if (!isGuildTextChannel(interaction.channel)) {
      yield* tryDiscordJsPromise(() =>
        interaction.reply("This command only works in guild text channels."),
      );
      return;
    }

    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const sessions = yield* ChannelSessions;
    const session = yield* sessions.get(interaction.channelId);
    const status = yield* session.status({
      channel: interaction.channel,
      promptContext: createPromptContext(
        interaction.client,
        interaction.channel,
        interaction.guild.name,
      ),
    });
    yield* tryDiscordJsPromise(() =>
      interaction.editReply({ embeds: [createStatusEmbed(status)] }),
    );
  }),
});
