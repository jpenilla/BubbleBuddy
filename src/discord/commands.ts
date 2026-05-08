import {
  type ChatInputCommandInteraction,
  type Client,
  Events,
  type Guild,
  type Interaction,
  SharedSlashCommand,
  SlashCommandBuilder,
} from "discord.js";
import { Cause, Effect, Layer, Scope } from "effect";

import type { ChannelRuntimeError } from "../channel-runtime.ts";
import { ChannelRuntimes } from "../channel-runtimes.ts";
import { createPromptContext, isGuildTextChannel } from "./utils.ts";
import { Discord } from "./client.ts";

export interface CommandContext {
  readonly client: Client<true>;
  readonly guild: Guild;
}

export interface CommandHandler {
  readonly data: SharedSlashCommand;
  readonly execute: (
    interaction: ChatInputCommandInteraction,
    context: CommandContext,
  ) => Effect.Effect<void, Cause.UnknownError | ChannelRuntimeError, ChannelRuntimes | Scope.Scope>;
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

// --- new ---

const newCommand: CommandHandler = {
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

// --- thinking ---

const thinkingCommand: CommandHandler = {
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

// --- registry ---

const commandRegistry = new Map<string, CommandHandler>([
  ["compact", compactCommand],
  ["new", newCommand],
  ["thinking", thinkingCommand],
]);

export const handleCommand = (
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Effect.Effect<void, never, ChannelRuntimes> =>
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
      Effect.scoped,
      Effect.ignore({ log: "Warn", message: "Error handling slash command" }),
    );
  });

export const SlashCommandsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo("Registering Discord slash commands.");
    const discord = yield* Discord;
    yield* Effect.tryPromise(() =>
      discord.client.application.commands.set(
        [...commandRegistry.values()].map((handler) => handler.data.toJSON()),
      ),
    );
    yield* discord.events.forkOn(Events.InteractionCreate, (interaction) =>
      handleInteraction(interaction),
    );
    yield* Effect.logInfo("Discord slash commands registered.");
  }),
);

const handleInteraction = (interaction: Interaction) =>
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
      guild: interaction.guild,
    });
  });
