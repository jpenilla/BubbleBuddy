import { InteractionContextType, SlashCommandBuilder } from "discord.js";

import { ChannelSessions } from "../../session/registry.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { createCommand, inGuildChannel } from "./command.ts";

export const discardSessionCommand = createCommand({
  data: new SlashCommandBuilder()
    .setName("new")
    .setDescription("Discard this channel's current pi session.")
    .setContexts(InteractionContextType.Guild),
  execute: inGuildChannel(function* (interaction) {
    yield* tryDiscordJsPromise(() => interaction.deferReply());
    const sessions = yield* ChannelSessions;
    const session = yield* sessions.get(interaction.channelId);
    const result = yield* session.discard;
    if (result === "rejected-busy") {
      yield* tryDiscordJsPromise(() =>
        interaction.editReply("A response is already in progress for this channel."),
      );
      return;
    }

    yield* tryDiscordJsPromise(() =>
      interaction.editReply("The next bot interaction in this channel will use a new session."),
    );
  }),
});
