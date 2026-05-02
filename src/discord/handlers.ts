import { Events, type Client, type Interaction, type Message } from "discord.js";
import { Effect } from "effect";

import type { ChannelSessionManager } from "../sessions.ts";
import { checkGuildMessageActivation, isActivationMessage } from "./activation.ts";
import { handleCommand, type CommandContext } from "./commands.ts";
import { createPromptContext, isGuildTextChannel } from "./utils.ts";
import { formatMessageForPrompt } from "./message-formatting.ts";

export function registerHandlers(client: Client<true>, sessions: ChannelSessionManager) {
  client.on(Events.MessageCreate, (message) => {
    if (!message.inGuild()) {
      return;
    }

    void Effect.runPromise(handleGuildMessage(client, sessions, message));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void Effect.runPromise(handleInteraction(client, sessions, interaction));
  });
}

const handleGuildMessage = (
  client: Client<true>,
  sessions: ChannelSessionManager,
  message: Message<true>,
) =>
  Effect.tryPromise(async () => {
    if (!isGuildTextChannel(message.channel)) {
      return;
    }

    const activation = await checkGuildMessageActivation(message, client.user.id);
    if (!isActivationMessage(activation)) {
      return;
    }

    const normalizedContent = formatMessageForPrompt(message);
    await sessions.activate(
      {
        channel: message.channel,
        originMessage: message,
        promptContext: createPromptContext(client, message.channel, message.guild.name),
      },
      normalizedContent,
    );
  });

const handleInteraction = (
  client: Client<true>,
  sessions: ChannelSessionManager,
  interaction: Interaction,
) =>
  Effect.tryPromise(async () => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!interaction.inGuild() || interaction.channel === null) {
      await interaction.reply({
        content: "This command only works in guild channels.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.guild === null) {
      await interaction.reply("This command only works in guild channels.");
      return;
    }

    const context: CommandContext = { client, sessions, guild: interaction.guild };
    await handleCommand(interaction, context);
  });
