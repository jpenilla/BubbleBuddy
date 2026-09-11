import { ContainerBuilder, TextDisplayBuilder } from "discord.js";

import { inlineCode } from "../shared/markdown.ts";
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

const formatEntry = (entry: ToolStatusEntry): string => {
  const heading = `${TOOL_STATUS_EMOJI[entry.phase]} **${entry.toolName}**`;
  return entry.description === undefined ? heading : `${heading}\n${inlineCode(entry.description)}`;
};

export const createToolStatusComponents = (entries: Iterable<ToolStatusEntry>): ContainerBuilder =>
  new ContainerBuilder()
    .setAccentColor(EMBED_COLOR.neutral)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("🛠️ **Tools**"),
      ...[...entries].map((entry) => new TextDisplayBuilder().setContent(formatEntry(entry))),
    );
