import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { Effect } from "effect";

import type { ChannelStatus } from "../../channels/channel-runtime.ts";
import { ChannelRuntimes } from "../../channels/channel-runtimes.ts";
import { createPromptContext, isGuildTextChannel } from "../utils.ts";
import type { CommandHandler } from "./types.ts";

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

export const statusCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show this channel's pi session token, cost, and runtime stats."),
  execute: (interaction, { client, guild }) =>
    Effect.gen(function* () {
      if (!isGuildTextChannel(interaction.channel)) {
        yield* Effect.tryPromise(() =>
          interaction.reply("This command only works in guild text channels."),
        );
        return;
      }

      yield* Effect.tryPromise(() => interaction.deferReply());
      const sessions = yield* ChannelRuntimes;
      const runtime = yield* sessions.get(interaction.channelId);
      const status = yield* runtime.status({
        channel: interaction.channel,
        promptContext: createPromptContext(client, interaction.channel, guild.name),
      });
      yield* Effect.tryPromise(() =>
        interaction.editReply({ embeds: [createStatusEmbed(status)] }),
      );
    }),
};
