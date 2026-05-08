import type { AssistantMessage } from "@earendil-works/pi-ai";

export const DISCORD_SAFE_MESSAGE_LIMIT = 1_900;

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

export const formatIncomingDiscordMessage = (
  messageId: string,
  authorUsername: string,
  authorId: string,
  content: string,
  usernamesById: ReadonlyMap<string, string>,
  inReplyToMessageId?: string,
): string => {
  const normalizedContent = normalizeIncomingUserMentions(content, usernamesById).trim();
  const replyReference = inReplyToMessageId !== undefined ? ` reply_to=${inReplyToMessageId}` : "";
  const prefix = `[msg ${messageId} user=${authorUsername} mention=<@${authorId}>${replyReference}]`;
  return normalizedContent.length === 0 ? prefix : `${prefix} ${normalizedContent}`;
};

export const extractAssistantText = (message: AssistantMessage): string =>
  message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

const THINKING_PREFIX = "🧠 _Thinking..._\n\n";
const THINKING_SUFFIX = "\n\n-# ──";

export const formatThinkingStatus = (thinking: string): string =>
  `${THINKING_PREFIX}${thinking}${THINKING_SUFFIX}`;

export const splitThinkingStatus = (
  thinking: string,
  limit = DISCORD_SAFE_MESSAGE_LIMIT,
): string[] => {
  const bodyLimit = Math.max(1, limit - Math.max(THINKING_PREFIX.length, THINKING_SUFFIX.length));
  const chunks = splitDiscordMessage(thinking, bodyLimit);

  return chunks.map((chunk, index) => {
    const prefix = index === 0 ? THINKING_PREFIX : "";
    const suffix = index === chunks.length - 1 ? THINKING_SUFFIX : "";
    return `${prefix}${chunk}${suffix}`;
  });
};

interface FenceState {
  readonly language?: string;
  readonly open: boolean;
}

const scanFenceState = (content: string): FenceState => {
  const pattern = /```([^\n`]*)?/g;
  let open = false;
  let language: string | undefined;

  for (const match of content.matchAll(pattern)) {
    if (!open) {
      const candidateLanguage = match[1]?.trim();
      language = candidateLanguage === "" ? undefined : candidateLanguage;
      open = true;
    } else {
      language = undefined;
      open = false;
    }
  }

  return { language, open };
};

const findSplitIndex = (content: string, limit: number): number => {
  if (content.length <= limit) {
    return content.length;
  }

  const window = content.slice(0, limit);
  if (window.startsWith("```")) {
    const codeLineBreak = window.lastIndexOf("\n");
    if (codeLineBreak > 0) {
      return codeLineBreak + 1;
    }
  }
  const candidates = [
    window.lastIndexOf("\n\n"),
    window.lastIndexOf("\n"),
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
    window.lastIndexOf(" "),
  ];

  for (const index of candidates) {
    if (index >= Math.floor(limit / 3)) {
      if (window.startsWith("\n\n", index)) {
        return index + 2;
      }
      if (
        window.startsWith(". ", index) ||
        window.startsWith("? ", index) ||
        window.startsWith("! ", index)
      ) {
        return index + 2;
      }
      return index + 1;
    }
  }

  return limit;
};

export const splitDiscordMessage = (
  content: string,
  limit = DISCORD_SAFE_MESSAGE_LIMIT,
): string[] => {
  if (content.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  let remaining = content;
  let reopenFencePrefix = "";

  while (remaining.length > 0) {
    const working = `${reopenFencePrefix}${remaining}`;
    const closingFence = "\n```";
    const minimumSplitIndex =
      working.length > reopenFencePrefix.length ? reopenFencePrefix.length + 1 : 1;
    let sliceLimit = reopenFencePrefix === "" ? limit : Math.max(1, limit);
    let splitIndex = findSplitIndex(working, sliceLimit);
    splitIndex = Math.max(splitIndex, minimumSplitIndex);
    let chunk = working.slice(0, splitIndex);
    let fenceState = scanFenceState(chunk);

    if (fenceState.open && chunk.length + closingFence.length > limit) {
      sliceLimit = Math.max(1, limit - closingFence.length);
      splitIndex = findSplitIndex(working, sliceLimit);
      splitIndex = Math.max(splitIndex, minimumSplitIndex);
      chunk = working.slice(0, splitIndex);
      fenceState = scanFenceState(chunk);
    }

    const consumedFromOriginal = chunk.length - reopenFencePrefix.length;
    if (consumedFromOriginal <= 0) {
      throw new Error("Message splitting made no forward progress.");
    }

    remaining = remaining.slice(consumedFromOriginal);

    if (fenceState.open) {
      chunks.push(`${chunk}${closingFence}`);
      reopenFencePrefix = `\`\`\`${fenceState.language ?? ""}\n`;
    } else {
      chunks.push(chunk);
      reopenFencePrefix = "";
    }
  }

  return chunks;
};
