import { SlashCommandBuilder } from "discord.js";

import { ChannelSessions } from "../../session/registry.ts";
import { isGuildTextChannel, tryDiscordJsPromise } from "../utils.ts";
import { createPromptContext } from "../prompt-formatting.ts";
import { createCommand, inGuildChannel } from "./command.ts";

export const compactCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Manually compact this channel's session context.")
    .addStringOption((option) =>
      option
        .setName("instructions")
        .setDescription("Custom instructions for the compaction summary")
        .setRequired(false),
    ),
  execute: inGuildChannel(function* (interaction) {
    if (!isGuildTextChannel(interaction.channel)) {
      yield* tryDiscordJsPromise(() =>
        interaction.reply("This command only works in guild text channels."),
      );
      return;
    }

    const customInstructions = interaction.options.getString("instructions")?.trim() || undefined;
    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const sessions = yield* ChannelSessions;
    const session = yield* sessions.get(interaction.channelId);
    yield* tryDiscordJsPromise(() => interaction.editReply("Compaction requested."));
    const result = yield* session.compact({
      channel: interaction.channel,
      promptContext: createPromptContext(
        interaction.client,
        interaction.channel,
        interaction.guild.name,
      ),
      customInstructions,
    });

    if (result !== "done") {
      let reply: string;
      switch (result) {
        case "no-session":
          reply = "No active session for this channel.";
          break;
        case "rejected-busy":
          reply = "A response is already in progress for this channel.";
          break;
        case "rejected-compacting":
          reply = "Compaction is already in progress for this channel.";
          break;
      }
      yield* tryDiscordJsPromise(() => interaction.editReply(reply));
    }
  }),
});
