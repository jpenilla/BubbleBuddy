import { type ChatInputCommandInteraction, Events, type Interaction } from "discord.js";
import { Effect, Layer } from "effect";

import { ChannelRuntimes } from "../../channels/channel-runtimes.ts";
import { Discord } from "../client.ts";
import { compactCommand } from "./compact.ts";
import { discardSessionCommand } from "./discard-session.ts";
import { statusCommand } from "./status.ts";
import { thinkingCommand } from "./thinking.ts";
import type { CommandContext, CommandHandler } from "./types.ts";

const commands = [compactCommand, discardSessionCommand, statusCommand, thinkingCommand];

const commandRegistry = new Map<string, CommandHandler>(
  commands.map((command) => [command.data.name, command]),
);

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
      discord.client.application.commands.set(commands.map((command) => command.data.toJSON())),
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
