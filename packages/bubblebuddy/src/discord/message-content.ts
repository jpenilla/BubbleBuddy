import { type MessageSnapshot } from "discord.js";

export type MessageContent = Pick<
  MessageSnapshot,
  "content" | "mentions" | "attachments" | "embeds" | "stickers" | "components"
>;
