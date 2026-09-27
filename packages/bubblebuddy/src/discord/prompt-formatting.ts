import {
  type Message,
  MessageReferenceType,
  StickerFormatType,
  type Sticker,
  InteractionType,
  type User,
  type GuildMember,
} from "discord.js";

import { collectMessageAssets, type MessageAssets } from "./message-assets.ts";
import { type MessageContent } from "./message-content.ts";

type UserIdentity = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
};

const resolveUserIdentity = (user: User, member?: GuildMember | null): UserIdentity => ({
  id: user.id,
  username: user.username,
  displayName: member?.displayName ?? user.displayName,
});

const formatFullMention = (user: UserIdentity): string =>
  `[ping user_name=${user.username} user_display=${JSON.stringify(user.displayName)} user_id=${user.id}]`;

const resolveMentions = (content: MessageContent): Map<string, UserIdentity> => {
  const usersById = new Map<string, UserIdentity>();
  for (const user of content.mentions.users.values()) {
    const member = content.mentions.members?.get(user.id);
    usersById.set(user.id, resolveUserIdentity(user, member));
  }
  return usersById;
};

export const normalizeIncomingUserMentions = (
  content: string,
  usersById: ReadonlyMap<string, UserIdentity>,
  seen: Set<string>,
): string => {
  return content.replace(/<@!?(\d+)>/g, (mention, id: string) => {
    const user = usersById.get(id);
    if (user === undefined) return mention;
    if (seen.has(id)) return `[ping user_name=${user.username}]`;
    seen.add(id);
    return formatFullMention(user);
  });
};

const formatObjects = (name: string, values: readonly string[]): string =>
  values.length === 0 ? "" : [`[${name}]`, ...values, `[/${name}]`].join("\n");

const formatSticker = (sticker: Sticker, index: number): string =>
  `[sticker ${index}] id=${sticker.id} name=${sticker.name} format=${StickerFormatType[sticker.format]} description=${sticker.description ?? ""} tags=${sticker.tags ?? ""}`;

const formatContent = (
  content: MessageContent,
  assets: MessageAssets,
  authorId?: string,
): string => {
  const mentionedUsers = resolveMentions(content);
  const seen = new Set(authorId === undefined ? [] : [authorId]);
  const text = normalizeIncomingUserMentions(content.content, mentionedUsers, seen).trim();
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
    const invoker = resolveUserIdentity(
      interactionMetadata.user,
      message.guild.members.resolve(interactionMetadata.user),
    );
    commandAttributes += ` invoked_by_user_name=${invoker.username} invoked_by_user_display=${JSON.stringify(invoker.displayName)} invoked_by_user_id=${invoker.id}`;
  }

  const author = resolveUserIdentity(message.author, message.member);
  const header = `[msg ${message.id} user_name=${author.username} user_display=${JSON.stringify(author.displayName)} user_id=${author.id}${replyReference}${commandAttributes}]`;
  const lines = [header, formatContent(message, messageAssets.main, message.author.id)].filter(
    (line) => line.length > 0,
  );
  if (messageAssets.forwarded !== undefined)
    lines.push(formatForwardedMessage(message, messageAssets.forwarded));
  return lines.join("\n");
};
