import {
  type ChatInputCommandInteraction,
  type Client,
  Events,
  type Guild,
  type Interaction,
  type Message,
  SharedSlashCommand,
  SlashCommandBuilder,
} from "discord.js";
import { Cause, Effect } from "effect";

import type { ChannelSessionManager } from "../sessions.ts";
import { SHOW_THINKING_DEFAULT } from "../channel-repository.ts";
import { createPromptContext, isGuildTextChannel } from "./utils.ts";
import { Discord } from "./client.ts";

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
  ) => Effect.Effect<void, Cause.UnknownError, never>;
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
  execute: (interaction, { client, sessions, guild }) =>
    Effect.tryPromise(async () => {
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
    }),
};

// --- new ---

const newCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("new")
    .setDescription("Discard this channel's current pi session."),
  execute: (interaction, { sessions }) =>
    Effect.tryPromise(async () => {
      await interaction.deferReply();
      const result = await sessions.discard(interaction.channelId);
      if (result === "rejected-busy") {
        await interaction.editReply("A response is already in progress for this channel.");
        return;
      }

      await interaction.editReply(
        "The next bot interaction in this channel will use a new session.",
      );
    }),
};

// --- thinking ---

const thinkingCommand: CommandHandler = {
  data: new SlashCommandBuilder()
    .setName("thinking")
    .setDescription("Toggle thinking messages in this channel."),
  execute: (interaction, { sessions }) =>
    Effect.tryPromise(async () => {
      await interaction.deferReply();
      const newValue = await sessions.withChannel(interaction.channelId, async (channel) => {
        const value = !(channel.settings.showThinking ?? SHOW_THINKING_DEFAULT);
        channel.modifySettings((settings) => {
          settings.showThinking = value === SHOW_THINKING_DEFAULT ? undefined : value;
        });
        return value;
      });
      await interaction.editReply(
        `Thinking messages are now ${newValue ? "enabled" : "disabled"} in this channel.`,
      );
    }),
};

// --- registry ---

const commandRegistry = new Map<string, CommandHandler>([
  ["compact", compactCommand],
  ["new", newCommand],
  ["thinking", thinkingCommand],
]);

export const handleCommand = (
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const handler = commandRegistry.get(interaction.commandName);
    if (handler === undefined) return;
    yield* handler.execute(interaction, context).pipe(
      Effect.withSpan(interaction.commandName),
      Effect.tapError(() =>
        Effect.tryPromise(async () => {
          if (interaction.deferred) {
            await interaction.editReply("Error handling slash command");
          } else if (!interaction.replied) {
            await interaction.reply("Error handling slash command");
          }
        }),
      ),
      Effect.ignore({ log: "Warn", message: "Error handling slash command" }),
    );
  });

export const registerSlashCommands = (sessions: ChannelSessionManager) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Registering Discord slash commands.");
    const discord = yield* Discord;
    yield* Effect.tryPromise(() =>
      discord.client.application.commands.set(
        [...commandRegistry.values()].map((handler) => handler.data.toJSON()),
      ),
    );
    yield* registerCommandHandler(sessions);
    yield* Effect.logInfo("Discord slash commands registered.");
  });

const registerCommandHandler = (sessions: ChannelSessionManager) =>
  Effect.gen(function* () {
    const discord = yield* Discord;
    yield* discord.events.forkOn(Events.InteractionCreate, (interaction) =>
      handleInteraction(sessions, interaction),
    );
  });

const handleInteraction = (sessions: ChannelSessionManager, interaction: Interaction) =>
  Effect.gen(function* () {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!interaction.inGuild() || interaction.channel === null || interaction.guild === null) {
      yield* Effect.tryPromise(() =>
        interaction.reply({
          content: "This command only works in guild channels.",
          ephemeral: true,
        }),
      );
      return;
    }

    const discord = yield* Discord;
    yield* handleCommand(interaction, {
      client: discord.client,
      sessions,
      guild: interaction.guild,
    });
  });
