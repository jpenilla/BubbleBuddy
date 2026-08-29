import type { ChatInputCommandInteraction, Client, Guild, SharedSlashCommand } from "discord.js";
import type { Cause, Effect, Scope } from "effect";

import type { ChannelSessionError } from "../../session/channel.ts";
import type { ChannelSessions } from "../../session/registry.ts";

export interface CommandContext {
  readonly client: Client<true>;
  readonly guild: Guild;
}

export interface CommandHandler {
  readonly data: SharedSlashCommand;
  readonly execute: (
    interaction: ChatInputCommandInteraction,
    context: CommandContext,
  ) => Effect.Effect<void, Cause.UnknownError | ChannelSessionError, ChannelSessions | Scope.Scope>;
}
