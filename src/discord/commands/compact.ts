import { SlashCommandBuilder } from "discord.js";
import { Effect } from "effect";

import { ChannelRuntimes } from "../../channels/channel-runtimes.ts";
import { createPromptContext, isGuildTextChannel } from "../utils.ts";
import type { CommandHandler } from "./types.ts";

export const compactCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Manually compact this channel's session context.")
    .addStringOption((option) =>
      option
        .setName("instructions")
        .setDescription("Custom instructions for the compaction summary")
        .setRequired(false),
    ),
  execute: (interaction, { client, guild }) =>
    Effect.gen(function* () {
      if (!isGuildTextChannel(interaction.channel)) {
        yield* Effect.tryPromise(() =>
          interaction.reply("This command only works in guild text channels."),
        );
        return;
      }

      const customInstructions = interaction.options.getString("instructions")?.trim() || undefined;
      yield* Effect.tryPromise(() => interaction.deferReply());
      const sessions = yield* ChannelRuntimes;
      const runtime = yield* sessions.get(interaction.channelId);
      yield* Effect.tryPromise(() => interaction.editReply("Compaction requested."));
      const result = yield* runtime.compact({
        channel: interaction.channel,
        promptContext: createPromptContext(client, interaction.channel, guild.name),
        customInstructions,
      });

      if (result !== "done") {
        let reply: string;
        switch (result) {
          case "no-session":
            reply = "No session exists yet for this channel";
            break;
          case "rejected-busy":
            reply = "A response is already in progress for this channel.";
            break;
          case "rejected-compacting":
            reply = "Compaction is already in progress for this channel.";
            break;
        }
        yield* Effect.tryPromise(() => interaction.editReply(reply));
      }
    }),
};
