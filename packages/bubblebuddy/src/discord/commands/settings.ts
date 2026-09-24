import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from "discord.js";

import { ChannelSettings } from "../../session/settings.ts";
import { EMBED_COLOR, tryDiscordJsPromise } from "../utils.ts";
import { createCommand, inGuildTextChannel } from "./command.ts";

export const settingsCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Show this channel's settings.")
    .setContexts(InteractionContextType.Guild),
  execute: inGuildTextChannel(function* (interaction) {
    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const settings = yield* (yield* ChannelSettings.Service).get(interaction.channelId);
    const replyMode = yield* settings.getReplyMode;
    const showThinking = yield* settings.getShowThinking;
    yield* tryDiscordJsPromise(() =>
      interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLOR.neutral)
            .setTitle("⚙️ Channel settings")
            .addFields(
              {
                name: "Reply mode",
                value: replyMode === "mention-only" ? "Mention only" : "Automatic",
              },
              { name: "Thinking messages", value: showThinking ? "Visible" : "Hidden" },
            ),
        ],
      }),
    );
  }),
});
