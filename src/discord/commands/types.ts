import type { ChatInputCommandInteraction, Client, Guild, SharedSlashCommand } from "discord.js";
import type { Cause, Effect, Scope } from "effect";

import type { ChannelRuntimeError } from "../../channels/channel-runtime.ts";
import type { ChannelRuntimes } from "../../channels/channel-runtimes.ts";

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
