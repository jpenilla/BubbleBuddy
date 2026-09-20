import { InteractionContextType, SlashCommandBuilder } from "discord.js";

import { ChannelSettings } from "../../session/settings.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { createCommand, inGuildTextChannel } from "./command.ts";

export const replyModeCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("reply-mode")
    .setDescription("Choose when the assistant responds in this channel.")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Response activation mode")
        .setRequired(true)
        .addChoices(
          { name: "Mention only", value: "mention-only" },
          { name: "Automatic", value: "automatic" },
        ),
    ),
  execute: inGuildTextChannel(function* (interaction) {
    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const mode = interaction.options.getString("mode", true);
    const replyMode = mode === "automatic" ? "automatic" : "mention-only";
    const settingsService = yield* ChannelSettings.Service;
    const settings = yield* settingsService.get(interaction.channelId);
    yield* settings.setReplyMode(replyMode);
    yield* tryDiscordJsPromise(() =>
      interaction.editReply(`Reply mode is now **${replyMode}** in this channel.`),
    );
  }),
});
