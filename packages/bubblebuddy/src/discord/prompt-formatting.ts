import {
  type Message,
  MessageReferenceType,
  StickerFormatType,
  type Sticker,
  InteractionType,
} from "discord.js";

import { collectMessageAssets, type MessageAssets } from "./message-assets.ts";
import { type MessageContent } from "./message-content.ts";

export const formatDiscordUserReference = (username: string, userId: string): string =>
  `@${username} mention=<@${userId}>`;

export const normalizeIncomingUserMentions = (
  content: string,
  usernamesById: ReadonlyMap<string, string>,
): string => {
  let normalized = content;

  for (const [id, username] of usernamesById.entries()) {
    const reference = formatDiscordUserReference(username, id);
    normalized = normalized.replaceAll(`<@${id}>`, reference);
    normalized = normalized.replaceAll(`<@!${id}>`, reference);
  }

  return normalized;
};

const formatObjects = (name: string, values: readonly string[]): string =>
  values.length === 0 ? "" : [`[${name}]`, ...values, `[/${name}]`].join("\n");

const formatSticker = (sticker: Sticker, index: number): string =>
  `[sticker ${index}] id=${sticker.id} name=${sticker.name} format=${StickerFormatType[sticker.format]} description=${sticker.description ?? ""} tags=${sticker.tags ?? ""}`;

const formatContent = (content: MessageContent, assets: MessageAssets): string => {
  const usernamesById = new Map(
    [...content.mentions.users.values()].map((user) => [user.id, user.username]),
  );
  const text = normalizeIncomingUserMentions(content.content, usernamesById).trim();
  const attachments = assets.attachments
    .map((attachment) => `${attachment.name} ${attachment.size} asset=${attachment.key}`)
    .join(", ");
  const textWithAttachments = [text, attachments.length > 0 ? `[attachments: ${attachments}]` : ""]
    .filter((part) => part.length > 0)
    .join(" ");
  const blocks = [
    formatObjects("embeds", assets.embeds),
    formatObjects("components", assets.components),
    ...[...content.stickers.values()].map(formatSticker),
  ];

  return [textWithAttachments, ...blocks].filter((line) => line.length > 0).join("\n");
};

const formatForwardedMessage = (message: Message<true>, assets: MessageAssets): string => {
  const snapshot = message.messageSnapshots.first()!;
  return ["[forwarded]", formatContent(snapshot, assets), "[/forwarded]"].join("\n");
};

export const formatMessageForPrompt = (message: Message<true>): string => {
  const messageAssets = collectMessageAssets(message);
  const isForward = message.reference?.type === MessageReferenceType.Forward;
  const replyTo = isForward ? undefined : message.reference?.messageId;
  const replyReference = replyTo == null ? "" : ` reply_to=${replyTo}`;

  const interactionMetadata = message.interactionMetadata;
  const isCommandResponse = interactionMetadata?.type == InteractionType.ApplicationCommand;
  let commandAttributes = "";
  if (isCommandResponse) {
    commandAttributes += " command_response";
    const commandName = message.interaction?.commandName;
    if (commandName) commandAttributes += ` command=${commandName}`;
    const invoker = interactionMetadata.user;
    commandAttributes += ` invoked_by_user=${invoker.username} invoked_by_user_mention=<@${invoker.id}>`;
  }

  const header = `[msg ${message.id} user=${message.author.username} mention=<@${message.author.id}>${replyReference}${commandAttributes}]`;
  const lines = [header, formatContent(message, messageAssets.main)].filter(
    (line) => line.length > 0,
  );
  if (messageAssets.forwarded !== undefined)
    lines.push(formatForwardedMessage(message, messageAssets.forwarded));
  return lines.join("\n");
};
