import { InteractionContextType, SlashCommandBuilder } from "discord.js";

import { ChannelSessions } from "../../session/registry.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { createCommand, inGuildChannel } from "./command.ts";

export const abortCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("abort")
    .setDescription("Abort the current run, compaction, or retry.")
    .setContexts(InteractionContextType.Guild),
  execute: inGuildChannel(function* (interaction) {
    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const sessions = yield* ChannelSessions;
    const session = yield* sessions.get(interaction.channelId);
    const result = yield* session.abort;

    switch (result) {
      case "aborted":
        yield* tryDiscordJsPromise(() => interaction.editReply("Aborted active operation."));
        return;
      case "idle":
        yield* tryDiscordJsPromise(() => interaction.editReply("Nothing is currently running."));
        return;
    }
  }),
});
