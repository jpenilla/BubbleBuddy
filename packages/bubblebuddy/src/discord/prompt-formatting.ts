import {
  type Client,
  type Embed,
  type GuildTextBasedChannel,
  Message,
  MessageFlags,
  StickerFormatType,
  type Sticker,
} from "discord.js";

import type { PromptTemplateContext } from "../pi/system-prompt.ts";
import { sanitizeAttachmentFilename } from "../shared/workspace.ts";

export const DISCORD_SAFE_MESSAGE_LIMIT = 1_900;

export const createPromptContext = (
  client: Client<true>,
  channel: GuildTextBasedChannel,
  guildName: string,
): PromptTemplateContext => ({
  botName: client.user.username,
  channelName:
    "name" in channel && typeof channel.name === "string" ? channel.name : "unknown-channel",
  channelStatusText:
    "topic" in channel && typeof channel.topic === "string"
      ? channel.topic.trim().length > 0
        ? channel.topic.trim()
        : "none"
      : "none",
  guildName,
});

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

export type PromptAttachment = {
  readonly name: string;
  readonly size: number;
};

const formatAttachmentsSuffix = (attachments: readonly PromptAttachment[]): string => {
  if (attachments.length === 0) return "";
  const entries = attachments.map(
    (att, idx) => `[${idx}] ${sanitizeAttachmentFilename(att.name)} ${att.size}`,
  );
  return ` [attachments: ${entries.join(", ")}]`;
};

const formatEmbedAsset = (
  asset: { readonly width?: number; readonly height?: number } | undefined,
) =>
  asset === undefined
    ? undefined
    : {
        width: asset.width,
        height: asset.height,
      };

const formatEmbed = (embed: Embed, index: number): string => {
  const { author, footer, image, thumbnail, video, ...content } = embed.toJSON();
  const formatted = {
    ...content,
    author:
      author === undefined
        ? undefined
        : {
            name: author.name,
            url: author.url,
            icon: author.icon_url === undefined ? undefined : true,
          },
    footer:
      footer === undefined
        ? undefined
        : { text: footer.text, icon: footer.icon_url === undefined ? undefined : true },
    image: formatEmbedAsset(image),
    thumbnail: formatEmbedAsset(thumbnail),
    video: formatEmbedAsset(video),
  };
  return `[embed ${index}]\n${JSON.stringify(formatted, undefined, 2)}\n[/embed ${index}]`;
};

const formatSticker = (sticker: Sticker, index: number): string =>
  `[sticker ${index}] id=${sticker.id} name=${sticker.name} format=${StickerFormatType[sticker.format]} description=${sticker.description ?? ""} tags=${sticker.tags ?? ""}`;

export const formatMessageForPrompt = (message: Message<true>): string => {
  const attachments = [...message.attachments.values()].map((att) => ({
    name: att.name,
    size: att.size,
  }));
  const formattedMessage = formatIncomingDiscordMessage(
    message.id,
    message.author.username,
    message.author.id,
    message.content,
    new Map([...message.mentions.users.values()].map((user) => [user.id, user.username])),
    message.reference?.messageId ?? undefined,
    attachments,
  );
  if (message.flags.has(MessageFlags.IsComponentsV2)) {
    return `${formattedMessage}\n[Discord Components V2 content display not yet implemented]`;
  }

  const extraBlocks = [
    ...message.embeds.map(formatEmbed),
    ...[...message.stickers.values()].map(formatSticker),
  ];
  return extraBlocks.length === 0
    ? formattedMessage
    : `${formattedMessage}\n${extraBlocks.join("\n")}`;
};

export const formatIncomingDiscordMessage = (
  messageId: string,
  authorUsername: string,
  authorId: string,
  content: string,
  usernamesById: ReadonlyMap<string, string>,
  inReplyToMessageId?: string,
  attachments: readonly PromptAttachment[] = [],
): string => {
  const normalizedContent = normalizeIncomingUserMentions(content, usernamesById).trim();
  const replyReference = inReplyToMessageId !== undefined ? ` reply_to=${inReplyToMessageId}` : "";
  const prefix = `[msg ${messageId} user=${authorUsername} mention=<@${authorId}>${replyReference}]`;
  const suffix = formatAttachmentsSuffix(attachments);
  const base = normalizedContent.length === 0 ? prefix : `${prefix} ${normalizedContent}`;
  return suffix.length === 0 ? base : `${base}${suffix}`;
};
