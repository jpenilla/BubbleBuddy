import {
  DiscordAPIError,
  DiscordjsError,
  DiscordjsRangeError,
  DiscordjsTypeError,
  HTTPError,
  MessagePayload,
  RateLimitError,
  Routes,
  type GuildTextBasedChannel,
  type Message,
  type MessageCreateOptions,
  type MessageMentionOptions,
  type ReplyOptions,
} from "discord.js";
import type { EmbedBuilder } from "discord.js";
import { Effect, Schema } from "effect";

import { splitDiscordMessage } from "./response-formatting.ts";

export class DiscordJsError extends Schema.TaggedError<DiscordJsError>()("DiscordJsError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

// These messages reach agent prompts, so only bounded discord.js error fields are
// surfaced; unrecognized causes stay generic because their content is unbounded
// (hosts, paths). The full cause is always retained for logs.
const describeDiscordJsCause = (cause: unknown): string => {
  if (cause instanceof DiscordAPIError) {
    return `Discord API error ${cause.code}: ${cause.message}`;
  }
  if (cause instanceof HTTPError) {
    return `Discord HTTP error ${cause.status}: ${cause.message}`;
  }
  // Only thrown if the client opts into rejectOnRateLimit; queued/retried otherwise.
  if (cause instanceof RateLimitError) {
    return `Discord rate limit on ${cause.method} ${cause.route} (retry after ${cause.retryAfter}ms)`;
  }
  if (
    cause instanceof DiscordjsError ||
    cause instanceof DiscordjsTypeError ||
    cause instanceof DiscordjsRangeError
  ) {
    return `discord.js client error ${cause.code}: ${cause.message}`;
  }
  return "Discord operation failed.";
};

export const tryDiscordJsPromise = <A>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, DiscordJsError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new DiscordJsError({ message: describeDiscordJsCause(cause), cause }),
  });

export const isGuildTextChannel = (channel: unknown): channel is GuildTextBasedChannel =>
  typeof channel === "object" &&
  channel !== null &&
  "isSendable" in channel &&
  typeof channel.isSendable === "function" &&
  channel.isSendable();

export const sendOrEditStatusCard = async (
  channel: GuildTextBasedChannel,
  existing: Message<true> | undefined,
  embed: EmbedBuilder,
): Promise<Message<true>> => {
  if (existing !== undefined) {
    await existing.edit({ embeds: [embed] });
    return existing;
  }

  return await channel.send({ embeds: [embed] });
};

export const sendChunkedMessage = async (opts: {
  channel: GuildTextBasedChannel;
  content: string;
  reply?: ReplyOptions;
  allowedMentions?: MessageMentionOptions;
}): Promise<void> => {
  const chunks = splitDiscordMessage(opts.content);

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0 && opts.reply !== undefined) {
      await opts.channel.send({
        content: chunk,
        reply: opts.reply,
        allowedMentions: opts.allowedMentions,
      });
      continue;
    }

    await opts.channel.send({
      content: chunk,
      allowedMentions: opts.allowedMentions,
    });
  }
};

export const sendMessageWithAbort = async (
  channel: GuildTextBasedChannel,
  signal: AbortSignal,
  options: MessageCreateOptions,
): Promise<void> => {
  const payload = MessagePayload.create(channel, options).resolveBody();
  const { body, files } = await payload.resolveFiles();
  await channel.client.rest.post(Routes.channelMessages(channel.id), {
    body,
    files: files ?? undefined,
    signal,
  });
};
