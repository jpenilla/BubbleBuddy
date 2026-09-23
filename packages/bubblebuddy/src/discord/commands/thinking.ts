import { InteractionContextType, SlashCommandBuilder } from "discord.js";

import { ChannelSettings } from "../../session/settings.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { createCommand, inGuildTextChannel } from "./command.ts";

export const thinkingCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("thinking")
    .setDescription("Toggle thinking messages in this channel.")
    .setContexts(InteractionContextType.Guild),
  execute: inGuildTextChannel(function* (interaction) {
    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const settingsService = yield* ChannelSettings.Service;
    const settings = yield* settingsService.get(interaction.channelId);
    const newValue = yield* settings.toggleShowThinking;
    yield* tryDiscordJsPromise(() =>
      interaction.editReply(
        `Thinking messages are now **${newValue ? "visible" : "hidden"}** in this channel.`,
      ),
    );
  }),
});
