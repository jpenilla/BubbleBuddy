import { SlashCommandBuilder } from "discord.js";

import { ChannelSessions } from "../../session/registry.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { createCommand, inGuildChannel } from "./command.ts";

export const thinkingCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("thinking")
    .setDescription("Toggle thinking messages in this channel."),
  execute: inGuildChannel(function* (interaction) {
    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const sessions = yield* ChannelSessions;
    const session = yield* sessions.get(interaction.channelId);
    const newValue = yield* session.toggleShowThinking;
    yield* tryDiscordJsPromise(() =>
      interaction.editReply(
        `Thinking messages are now ${newValue ? "enabled" : "disabled"} in this channel.`,
      ),
    );
  }),
});
