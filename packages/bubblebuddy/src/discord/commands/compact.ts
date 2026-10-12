import { InteractionContextType, SlashCommandBuilder } from "discord.js";

import { ChannelSessions } from "../../session/registry.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { createCommand, inGuildTextChannel } from "./command.ts";

export const compactCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Manually compact this channel's session context.")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("instructions")
        .setDescription("Custom instructions for the compaction summary")
        .setRequired(false),
    ),
  execute: inGuildTextChannel(function* (interaction) {
    const customInstructions = interaction.options.getString("instructions")?.trim() || undefined;
    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const sessions = yield* ChannelSessions.Service;
    const session = yield* sessions.get(interaction.channelId);
    const result = yield* session.compact({
      channel: interaction.channel,
      customInstructions,
    });
    yield* tryDiscordJsPromise(() =>
      interaction.editReply(
        result === "requested" ? "Compaction requested." : "No active session for this channel.",
      ),
    );
  }),
});
