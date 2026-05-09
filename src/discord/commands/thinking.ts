import { SlashCommandBuilder } from "discord.js";
import { Effect } from "effect";

import { ChannelRuntimes } from "../../channels/channel-runtimes.ts";
import type { CommandHandler } from "./types.ts";

export const thinkingCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("thinking")
    .setDescription("Toggle thinking messages in this channel."),
  execute: (interaction) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => interaction.deferReply());
      const sessions = yield* ChannelRuntimes;
      const runtime = yield* sessions.get(interaction.channelId);
      const newValue = yield* runtime.toggleShowThinking();
      yield* Effect.tryPromise(() =>
        interaction.editReply(
          `Thinking messages are now ${newValue ? "enabled" : "disabled"} in this channel.`,
        ),
      );
    }),
};
