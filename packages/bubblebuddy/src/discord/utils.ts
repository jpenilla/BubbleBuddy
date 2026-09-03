import {
  MessagePayload,
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

export const EMBED_COLOR = {
  danger: 0xe74c3c,
  pending: 0xf1c40f,
  success: 0x2ecc71,
  neutral: 0x5865f2,
} as const;

export class DiscordJsError extends Schema.TaggedError<DiscordJsError>()("DiscordJsError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const tryDiscordJsPromise = <A>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, DiscordJsError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new DiscordJsError({ message: "Discord operation failed.", cause }),
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

export const sendChunkedMessage = Effect.fn("sendChunkedMessage")(function* (opts: {
  channel: GuildTextBasedChannel;
  content: string;
  reply?: ReplyOptions;
  allowedMentions?: MessageMentionOptions;
}) {
  const chunks = splitDiscordMessage(opts.content);

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0 && opts.reply !== undefined) {
      yield* sendMessage(opts.channel, {
        content: chunk,
        reply: opts.reply,
        allowedMentions: opts.allowedMentions,
      });
      continue;
    }

    yield* sendMessage(opts.channel, {
      content: chunk,
      allowedMentions: opts.allowedMentions,
    });
  }
});

export const sendMessage = Effect.fn("sendMessage")(function* (
  channel: GuildTextBasedChannel,
  options: MessageCreateOptions,
) {
  return yield* tryDiscordJsPromise(async (signal) => {
    const payload = MessagePayload.create(channel, options).resolveBody();
    const { body, files } = await payload.resolveFiles();
    await channel.client.rest.post(Routes.channelMessages(channel.id), {
      body,
      files: files ?? undefined,
      signal,
    });
  });
});
