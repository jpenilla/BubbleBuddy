import { splitAiResponse } from "../shared/text-split.ts";

export const DISCORD_SAFE_MESSAGE_LIMIT = 1_900;
export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4_096;

export const truncateDiscordEmbedDescription = (description: string): string =>
  description.length <= DISCORD_EMBED_DESCRIPTION_LIMIT
    ? description
    : `${description.slice(0, DISCORD_EMBED_DESCRIPTION_LIMIT - 1)}…`;

const THINKING_PREFIX = "🧠 _Thinking..._\n\n";
const THINKING_SUFFIX = "\n\n-# ──";

export const formatThinkingStatus = (thinking: string): string =>
  `${THINKING_PREFIX}${thinking}${THINKING_SUFFIX}`;

export const splitThinkingStatus = (
  thinking: string,
  limit = DISCORD_SAFE_MESSAGE_LIMIT,
): string[] => {
  const bodyLimit = Math.max(1, limit - Math.max(THINKING_PREFIX.length, THINKING_SUFFIX.length));
  const chunks = splitAiResponse(thinking, bodyLimit);

  return chunks.map((chunk, index) => {
    const prefix = index === 0 ? THINKING_PREFIX : "";
    const suffix = index === chunks.length - 1 ? THINKING_SUFFIX : "";
    return `${prefix}${chunk}${suffix}`;
  });
};

export const splitDiscordMessage = (
  content: string,
  limit = DISCORD_SAFE_MESSAGE_LIMIT,
): string[] => splitAiResponse(content, limit);
