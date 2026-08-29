import { SlashCommandBuilder } from "discord.js";
import { Effect } from "effect";

import { ChannelSessions } from "../../session/registry.ts";
import type { CommandHandler } from "./types.ts";

export const thinkingCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("thinking")
    .setDescription("Toggle thinking messages in this channel."),
  execute: (interaction) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => interaction.deferReply());
      const sessions = yield* ChannelSessions;
      const session = yield* sessions.get(interaction.channelId);
      const newValue = yield* session.toggleShowThinking;
      yield* Effect.tryPromise(() =>
        interaction.editReply(
          `Thinking messages are now ${newValue ? "enabled" : "disabled"} in this channel.`,
        ),
      );
    }),
};
