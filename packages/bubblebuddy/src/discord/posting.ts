import { type MessageCreateOptions } from "discord.js";
import { Context, type Effect } from "effect";

import { type DiscordJsError, type SendChunkedOptions } from "./utils.ts";

export interface Interface {
  readonly send: (options: MessageCreateOptions) => Effect.Effect<void, DiscordJsError>;
  /** Posts text split across as many messages as it needs. */
  readonly sendChunked: (options: SendChunkedOptions) => Effect.Effect<void, DiscordJsError>;
}

/** Posting to the channel, provided only inside the channel feed's lane so every post is ordered. */
export class Service extends Context.Service<Service, Interface>()("bubblebuddy/discord/Posting") {}

/**
 * Runs a tool's Discord action in the channel feed's lane, once the channel shows everything the conversation
 * committed before it, such as the answer text before the tool's call.
 */
export type ExecuteOrdered = <A, E>(operation: Effect.Effect<A, E, Service>) => Effect.Effect<A, E>;

export const send = (options: MessageCreateOptions) =>
  Service.use((posting) => posting.send(options));

export const sendChunked = (options: SendChunkedOptions) =>
  Service.use((posting) => posting.sendChunked(options));

export * as Posting from "./posting.ts";
