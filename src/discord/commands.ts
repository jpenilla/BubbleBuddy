import {
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Message,
  SharedSlashCommand,
  SlashCommandBuilder,
} from "discord.js";
import { Effect } from "effect";

import type { ChannelSessionManager } from "../sessions.ts";
import { SHOW_THINKING_DEFAULT } from "../channel-repository.ts";
import { createPromptContext, isGuildTextChannel } from "./utils.ts";

export interface CommandContext {
  readonly client: Client<true>;
  readonly sessions: ChannelSessionManager;
  readonly guild: Guild;
}

export interface CommandHandler {
  readonly data: SharedSlashCommand;
  readonly execute: (
    interaction: ChatInputCommandInteraction,
    context: CommandContext,
  ) => Promise<void>;
}

// --- compact ---

const compactCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Manually compact this channel's session context.")
    .addStringOption((option) =>
      option
        .setName("instructions")
        .setDescription("Custom instructions for the compaction summary")
        .setRequired(false),
    ),
  execute: async (interaction, { client, sessions, guild }) => {
    if (!isGuildTextChannel(interaction.channel)) {
      await interaction.reply("This command only works in guild text channels.");
      return;
    }

    const customInstructions = interaction.options.getString("instructions")?.trim() || undefined;
    await interaction.deferReply();
    const originMessage = (await interaction.fetchReply()) as Message<true>;
    const result = await sessions.compact(
      {
        channel: interaction.channel,
        originMessage,
        promptContext: createPromptContext(client, interaction.channel, guild.name),
      },
      customInstructions,
    );

    switch (result) {
      case "started":
        await interaction.editReply("Compaction requested.");
        break;
      case "no-session":
        await interaction.editReply("No session exists yet for this channel.");
        break;
      case "rejected-busy":
        await interaction.editReply("A response is already in progress for this channel.");
        break;
      case "rejected-compacting":
        await interaction.editReply("Compaction is already in progress for this channel.");
        break;
    }
  },
};

// --- new ---

const newCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("new")
    .setDescription("Discard this channel's current pi session."),
  execute: async (interaction, { sessions }) => {
    const result = await sessions.discard(interaction.channelId);
    if (result === "rejected-busy") {
      await interaction.reply("A response is already in progress for this channel.");
      return;
    }

    await interaction.reply("The next bot interaction in this channel will use a new session.");
  },
};

// --- thinking ---

const thinkingCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("thinking")
    .setDescription("Toggle thinking messages in this channel."),
  execute: async (interaction, { sessions }) => {
    let reply: string;
    try {
      const newValue = await sessions.withChannel(interaction.channelId, async (channel) => {
        const value = !(channel.settings.showThinking ?? SHOW_THINKING_DEFAULT);
        channel.modifySettings((settings) => {
          settings.showThinking = value === SHOW_THINKING_DEFAULT ? undefined : value;
        });
        return value;
      });
      reply = `Thinking messages are now ${newValue ? "enabled" : "disabled"} in this channel.`;
    } catch (error) {
      void Effect.runFork(Effect.logWarning("Failed to update thinking setting", error));
      reply = "Failed to update the thinking setting. Please try again later.";
    }
    await interaction.reply(reply);
  },
};

// --- registry ---

const commandRegistry = new Map<string, CommandHandler>([
  ["compact", compactCommand],
  ["new", newCommand],
  ["thinking", thinkingCommand],
]);

export const handleCommand = async (
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Promise<void> => {
  const handler = commandRegistry.get(interaction.commandName);
  if (handler === undefined) return;
  await handler.execute(interaction, context);
};

export const registerSlashCommands = async (client: Client<true>): Promise<void> => {
  await client.application.commands.set(
    [...commandRegistry.values()].map((handler) => handler.data.toJSON()),
  );
};
