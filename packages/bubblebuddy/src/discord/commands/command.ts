import type {
  ChatInputCommandInteraction,
  Guild,
  GuildTextBasedChannel,
  SharedSlashCommand,
} from "discord.js";
import { Cause, Effect } from "effect";

import type { DiscordEventListener } from "../client.ts";
import { isGuildTextChannel, tryDiscordJsPromise } from "../utils.ts";

type GuildTextChannelInteraction = ChatInputCommandInteraction<"raw" | "cached"> & {
  readonly channel: GuildTextBasedChannel;
  readonly guild: Guild;
};

export interface Command {
  readonly data: SharedSlashCommand;
  readonly execute: (interaction: ChatInputCommandInteraction) => Effect.Effect<void>;
}

export interface CommandDefinition<E, R> {
  readonly data: SharedSlashCommand;
  readonly execute: (interaction: ChatInputCommandInteraction) => Effect.Effect<void, E, R>;
}

export interface CommandDispatcher extends DiscordEventListener<
  "interactionCreate",
  Effect.Effect<void>
> {}

export const createCommand = <E, R>(definition: CommandDefinition<E, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    return {
      data: definition.data,
      execute: (interaction) =>
        definition.execute(interaction).pipe(
          Effect.scoped,
          Effect.provide(context),
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
              yield* tryDiscordJsPromise(async () => {
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
          Effect.withSpan("Command.execute", {
            attributes: { commandName: interaction.commandName },
          }),
        ),
    } satisfies Command;
  });

export const createCommandDispatcher = (commands: readonly Command[]): CommandDispatcher => {
  const registry = new Map(commands.map((command) => [command.data.name, command]));
  return (interaction) =>
    Effect.gen(function* () {
      if (!interaction.isChatInputCommand()) return;
      const command = registry.get(interaction.commandName);
      if (command !== undefined) yield* command.execute(interaction);
    });
};

const isGuildTextChannelInteraction = (
  interaction: ChatInputCommandInteraction,
): interaction is GuildTextChannelInteraction =>
  interaction.inGuild() && interaction.guild !== null && isGuildTextChannel(interaction.channel);

export const inGuildTextChannel = <Eff extends Effect.Effect<unknown, unknown, unknown>, A>(
  execute: (interaction: GuildTextChannelInteraction) => Generator<Eff, A, never>,
) =>
  Effect.fnUntraced(function* (interaction: ChatInputCommandInteraction) {
    if (!isGuildTextChannelInteraction(interaction)) {
      yield* tryDiscordJsPromise(() =>
        interaction.reply({
          content: "This command only works in guild text channels.",
          ephemeral: true,
        }),
      );
      return;
    }
    yield* Effect.gen(() => execute(interaction));
  });
