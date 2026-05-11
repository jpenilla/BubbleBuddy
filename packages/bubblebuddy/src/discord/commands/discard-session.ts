import { SlashCommandBuilder } from "discord.js";
import { Effect } from "effect";

import { ChannelRuntimes } from "../../channels/channel-runtimes.ts";
import type { CommandHandler } from "./types.ts";

export const discardSessionCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("new")
    .setDescription("Discard this channel's current pi session."),
  execute: (interaction) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => interaction.deferReply());
      const sessions = yield* ChannelRuntimes;
      const runtime = yield* sessions.get(interaction.channelId);
      const result = yield* runtime.discardPiSession();
      if (result === "rejected-busy") {
        yield* Effect.tryPromise(() =>
          interaction.editReply("A response is already in progress for this channel."),
        );
        return;
      }

      yield* Effect.tryPromise(() =>
        interaction.editReply("The next bot interaction in this channel will use a new session."),
      );
    }),
};
