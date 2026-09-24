import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from "discord.js";

import { type SessionStatus } from "../../session/channel.ts";
import { ChannelSessions } from "../../session/registry.ts";
import { EMBED_COLOR, tryDiscordJsPromise } from "../utils.ts";
import { createCommand, inGuildTextChannel } from "./command.ts";

const formatNumber = (value: number): string => value.toLocaleString();
const formatCost = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const ACTIVITY_LABELS: Record<SessionStatus["activity"], string> = {
  idle: "💤 Idle",
  working: "⏳ Working",
  retrying: "🔄 Retrying",
  compacting: "🗜️ Compacting",
};

const formatContext = (status: SessionStatus): string => {
  const usage = status.stats.contextUsage;
  if (usage?.percent == null || usage.tokens == null) {
    return `[${"░▒".repeat(5)}] ?${usage === undefined ? "" : ` / ${formatNumber(usage.contextWindow)}`}`;
  }
  const filled = Math.round(Math.max(0, Math.min(100, usage.percent)) / 10);
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${Math.round(usage.percent)}% · ${formatNumber(usage.tokens)} / ${formatNumber(usage.contextWindow)}`;
};

const createStatusEmbed = (status: SessionStatus, detailed: boolean): EmbedBuilder => {
  const model =
    status.model === undefined
      ? "unknown"
      : [
          status.model.name,
          status.model.thinkingLevel,
          ...(detailed ? [status.model.provider] : []),
        ].join(" · ");

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR.neutral)
    .setTitle("📜 Channel Status")
    .addFields(
      { name: "Activity", value: ACTIVITY_LABELS[status.activity] },
      { name: "Model", value: model },
      { name: "Context", value: formatContext(status) },
      { name: "Session Cost", value: `~${formatCost(status.stats.cost)}` },
    );

  if (detailed) {
    embed.addFields(
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
    );
  }
  return embed;
};

export const statusCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show this channel's session status.")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("view")
        .setDescription("Level of detail")
        .addChoices({ name: "Summary", value: "summary" }, { name: "Detailed", value: "detailed" }),
    ),
  execute: inGuildTextChannel(function* (interaction) {
    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const sessions = yield* ChannelSessions.Service;
    const session = yield* sessions.get(interaction.channelId);
    const status = yield* session.status(interaction.channel);
    yield* tryDiscordJsPromise(() =>
      interaction.editReply({
        embeds: [createStatusEmbed(status, interaction.options.getString("view") === "detailed")],
      }),
    );
  }),
});
