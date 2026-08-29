import { type ChatInputCommandInteraction, Events, type Interaction } from "discord.js";
import { Cause, Effect, Layer } from "effect";

import { ChannelSessions } from "../../session/registry.ts";
import { Discord } from "../client.ts";
import { abortCommand } from "./abort.ts";
import { compactCommand } from "./compact.ts";
import { discardSessionCommand } from "./discard-session.ts";
import { statusCommand } from "./status.ts";
import { thinkingCommand } from "./thinking.ts";
import type { CommandContext, CommandHandler } from "./types.ts";

const commands = [
  abortCommand,
  compactCommand,
  discardSessionCommand,
  statusCommand,
  thinkingCommand,
];

const commandRegistry = new Map<string, CommandHandler>(
  commands.map((command) => [command.data.name, command]),
);

export const handleCommand = (
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Effect.Effect<void, never, ChannelSessions> =>
  Effect.gen(function* () {
    const handler = commandRegistry.get(interaction.commandName);
    if (handler === undefined) return;
    yield* handler.execute(interaction, context).pipe(
      Effect.scoped,
      Effect.onError((cause) => {
        const interrupted = Cause.hasInterruptsOnly(cause);
        return Effect.gen(function* () {
          yield* interrupted
            ? Effect.logDebug("Slash command interrupted", {
                commandName: interaction.commandName,
                cause,
              })
            : Effect.logWarning("Error handling slash command", {
                commandName: interaction.commandName,
                cause,
              });
          yield* Effect.tryPromise(async () => {
            if (interaction.deferred) {
              await interaction.editReply(
                interrupted ? "Command interrupted." : "Error handling slash command",
              );
            } else if (!interaction.replied) {
              await interaction.reply(
                interrupted ? "Command interrupted." : "Error handling slash command",
              );
            }
          }).pipe(Effect.timeout("3 seconds"), Effect.ignore());
        });
      }),
      Effect.ignoreCause(),
      Effect.withSpan("CommandHandler.execute", {
        attributes: { commandName: interaction.commandName },
      }),
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
