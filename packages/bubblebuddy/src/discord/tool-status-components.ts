import { ContainerBuilder, TextDisplayBuilder } from "discord.js";

import { EMBED_COLOR } from "./utils.ts";

export interface ToolStatusEntry {
  readonly phase: "running" | "success" | "error";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly description?: string;
}

const TOOL_STATUS_EMOJI = {
  running: "⏳",
  success: "✅",
  error: "❌",
} as const;

const escapeInlineCode = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");

const formatEntry = (entry: ToolStatusEntry): string => {
  const heading = `${TOOL_STATUS_EMOJI[entry.phase]} **${entry.toolName}**`;
  return entry.description === undefined
    ? heading
    : `${heading}\n\`${escapeInlineCode(entry.description)}\``;
};

export const createToolStatusComponents = (entries: readonly ToolStatusEntry[]): ContainerBuilder =>
  new ContainerBuilder()
    .setAccentColor(EMBED_COLOR.neutral)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("🛠️ **Tools**"),
      ...entries.map((entry) => new TextDisplayBuilder().setContent(formatEntry(entry))),
    );
