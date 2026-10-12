import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from "discord.js";

import { type MessageCounts, type SessionStatus } from "../../pi/session-status.ts";
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
  const usage = status.contextUsage;
  if (usage?.percent == null || usage.tokens == null) {
    return `[${"░▒".repeat(5)}] ?${usage === undefined ? "" : ` / ${formatNumber(usage.contextWindow)}`}`;
  }
  const filled = Math.round(Math.max(0, Math.min(100, usage.percent)) / 10);
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${Math.round(usage.percent)}% · ${formatNumber(usage.tokens)} / ${formatNumber(usage.contextWindow)}`;
};

/** `messages` is given for the detailed view. */
const createStatusEmbed = (status: SessionStatus, messages?: MessageCounts): EmbedBuilder => {
  const model =
    status.model === undefined
      ? "unknown"
      : [
          status.model.name,
          status.model.thinkingLevel,
          ...(messages === undefined ? [] : [status.model.provider]),
        ].join(" · ");

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR.neutral)
    .setTitle("📜 Channel Status")
    .addFields(
      {
        name: "Activity",
        value: status.compactingInBackground
          ? `${ACTIVITY_LABELS[status.activity]}\n🗜️ *Compacting in background*`
          : ACTIVITY_LABELS[status.activity],
      },
      { name: "Model", value: model },
      { name: "Context", value: formatContext(status) },
      { name: "Session Cost", value: `~${formatCost(status.cost)}` },
    );

  if (messages !== undefined) {
    embed.addFields(
      {
        name: "Messages",
        value: [
          `User: ${formatNumber(messages.user)}`,
          `Assistant: ${formatNumber(messages.assistant)}`,
          `Tools: ${formatNumber(messages.toolCalls)} calls / ${formatNumber(messages.toolResults)} results`,
          `Total: ${formatNumber(messages.total)}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Tokens",
        value: [
          `Input: ${formatNumber(status.tokens.input)}`,
          `Output: ${formatNumber(status.tokens.output)}`,
          `Cache read/write: ${formatNumber(status.tokens.cacheRead)} / ${formatNumber(status.tokens.cacheWrite)}`,
          `Total: ${formatNumber(status.tokens.total)}`,
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
    const messages =
      interaction.options.getString("view") === "detailed"
        ? yield* session.messageCounts(interaction.channel)
        : undefined;
    yield* tryDiscordJsPromise(() =>
      interaction.editReply({ embeds: [createStatusEmbed(status, messages)] }),
    );
  }),
});
