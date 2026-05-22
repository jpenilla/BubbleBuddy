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
import { Effect } from "effect";

import { splitDiscordMessage } from "./response-formatting.ts";

export const tryDiscordJsPromise = <A>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => cause,
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
