import type { Message } from "discord.js";

import { formatIncomingDiscordMessage } from "../domain/text.ts";

export const formatMessageForPrompt = (message: Message<true>): string =>
  formatIncomingDiscordMessage(
    message.id,
    message.author.username,
    message.author.id,
    message.content,
    new Map([...message.mentions.users.values()].map((user) => [user.id, user.username])),
    message.reference?.messageId ?? undefined,
  );
