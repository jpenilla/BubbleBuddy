import {
  MessagePayload,
  Routes,
  type GuildTextBasedChannel,
  type MessageCreateOptions,
  type MessageEditOptions,
  type MessageMentionOptions,
  type ReplyOptions,
  type Snowflake,
} from "discord.js";
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

const discordJsError = (cause: unknown) =>
  new DiscordJsError({ message: "Discord operation failed.", cause });

export const tryDiscordJsPromise = <A>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, DiscordJsError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: discordJsError,
  });

export const tryDiscordJsOperation = <A>(evaluate: () => A): Effect.Effect<A, DiscordJsError> =>
  Effect.try({
    try: evaluate,
    catch: discordJsError,
  });

export const isGuildTextChannel = (channel: unknown): channel is GuildTextBasedChannel =>
  typeof channel === "object" &&
  channel !== null &&
  "isSendable" in channel &&
  typeof channel.isSendable === "function" &&
  channel.isSendable();

// Requests go through the REST client so an interrupted upload is aborted.
const resolvePayload = Effect.fnUntraced(function* (
  channel: GuildTextBasedChannel,
  options: MessageCreateOptions | MessageEditOptions,
) {
  const payload = yield* tryDiscordJsOperation(() =>
    MessagePayload.create(channel, options).resolveBody(),
  );
  const { body, files } = yield* tryDiscordJsPromise(() => payload.resolveFiles());
  return { body, files: files ?? undefined };
});

const decodeSentMessage = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));

/** Sends a message and returns its ID. */
export const sendMessage = Effect.fn("sendMessage")(function* (
  channel: GuildTextBasedChannel,
  options: MessageCreateOptions,
) {
  const payload = yield* resolvePayload(channel, options);
  const { id } = yield* tryDiscordJsPromise(async (signal) =>
    decodeSentMessage(
      await channel.client.rest.post(Routes.channelMessages(channel.id), { ...payload, signal }),
    ),
  );
  return id;
});

export const editMessage = Effect.fn("editMessage")(function* (
  channel: GuildTextBasedChannel,
  id: Snowflake,
  options: MessageEditOptions,
) {
  const payload = yield* resolvePayload(channel, options);
  yield* tryDiscordJsPromise((signal) =>
    channel.client.rest.patch(Routes.channelMessage(channel.id, id), { ...payload, signal }),
  );
});

export const sendChunkedMessage = Effect.fn("sendChunkedMessage")(function* (opts: {
  channel: GuildTextBasedChannel;
  content: string;
  reply?: ReplyOptions;
  allowedMentions?: MessageMentionOptions;
  /** Called with each chunk's message ID once it is sent. */
  onSent?: (id: Snowflake) => Effect.Effect<void>;
}) {
  const chunks = splitDiscordMessage(opts.content);
  const send = (options: MessageCreateOptions) =>
    sendMessage(opts.channel, options).pipe(
      Effect.tap((id) => (opts.onSent === undefined ? Effect.void : opts.onSent(id))),
    );

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0 && opts.reply !== undefined) {
      yield* send({
        content: chunk,
        reply: opts.reply,
        allowedMentions: opts.allowedMentions,
      });
      continue;
    }

    yield* send({
      content: chunk,
      allowedMentions: opts.allowedMentions,
    });
  }
});
