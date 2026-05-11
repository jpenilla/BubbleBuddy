import { SlashCommandBuilder } from "discord.js";
import { Effect } from "effect";

import { ChannelRuntimes } from "../../channels/channel-runtimes.ts";
import type { CommandHandler } from "./types.ts";

export const abortCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("abort")
    .setDescription("Abort the current run, compaction, or retry."),
  execute: (interaction) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => interaction.deferReply());
      const sessions = yield* ChannelRuntimes;
      const runtime = yield* sessions.get(interaction.channelId);
      const result = yield* runtime.abort();

      switch (result) {
        case "aborted":
          yield* Effect.tryPromise(() => interaction.editReply("Aborted active operation."));
          return;
        case "idle":
          yield* Effect.tryPromise(() => interaction.editReply("Nothing is currently running."));
          return;
      }
    }),
};
