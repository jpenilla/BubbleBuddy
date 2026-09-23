import {
  type Embed,
  type Message,
  MessageFlags,
  MessageReferenceType,
  StickerFormatType,
  type MessageSnapshot,
  type Sticker,
  InteractionType,
} from "discord.js";

import { sanitizeAttachmentFilename } from "../shared/workspace.ts";

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

type MessageBody = Pick<
  MessageSnapshot,
  "content" | "mentions" | "attachments" | "embeds" | "stickers" | "flags"
>;

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

const formatMessageBody = (body: MessageBody): string => {
  const usernamesById = new Map(
    [...body.mentions.users.values()].map((user) => [user.id, user.username]),
  );
  const text = normalizeIncomingUserMentions(body.content, usernamesById).trim();
  const attachments = [...body.attachments.values()]
    .map(
      (attachment, index) =>
        `[${index}] ${sanitizeAttachmentFilename(attachment.name)} ${attachment.size}`,
    )
    .join(", ");
  const textWithAttachments = [text, attachments.length > 0 ? `[attachments: ${attachments}]` : ""]
    .filter((part) => part.length > 0)
    .join(" ");
  const blocks = body.flags.has(MessageFlags.IsComponentsV2)
    ? ["[Discord Components V2 content display not yet implemented]"]
    : [...body.embeds.map(formatEmbed), ...[...body.stickers.values()].map(formatSticker)];

  return [textWithAttachments, ...blocks].filter((line) => line.length > 0).join("\n");
};

const formatForwardedMessage = (message: Message<true>): string => {
  const snapshot = message.messageSnapshots.first()!;
  return ["[forwarded]", formatMessageBody(snapshot), "[/forwarded]"].join("\n");
};

export const formatMessageForPrompt = (message: Message<true>): string => {
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
    commandAttributes += ` invoked_by_user=${invoker.username} invoked_by_mention=<@${invoker.id}>`;
  }

  const header = `[msg ${message.id} user=${message.author.username} mention=<@${message.author.id}>${replyReference}${commandAttributes}]`;
  const lines = [header, formatMessageBody(message)].filter((line) => line.length > 0);
  if (isForward) lines.push(formatForwardedMessage(message));
  return lines.join("\n");
};
