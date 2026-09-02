import { ContainerBuilder, TextDisplayBuilder } from "discord.js";

import { EMBED_COLOR } from "./utils.ts";

export interface ToolStatusEntry {
  readonly phase: "running" | "success" | "error";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly description?: string;
  readonly startedAt: number;
  readonly elapsedMs?: number;
}

const TOOL_STATUS_EMOJI = {
  running: "⏳",
  success: "✅",
  error: "❌",
} as const;

const formatElapsed = (elapsedMs: number): string => {
  if (elapsedMs < 1_000) return `${elapsedMs}ms`;
  if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(elapsedMs / 60_000);
  const seconds = Math.floor((elapsedMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};

const escapeInlineCode = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");

const formatEntry = (entry: ToolStatusEntry): string => {
  const elapsed = entry.elapsedMs === undefined ? "" : ` · ${formatElapsed(entry.elapsedMs)}`;
  const heading = `${TOOL_STATUS_EMOJI[entry.phase]} **${entry.toolName}**${elapsed}`;
  return entry.description === undefined
    ? heading
    : `${heading}\n-# \`${escapeInlineCode(entry.description)}\``;
};

const groupColor = (entries: readonly ToolStatusEntry[]): number => {
  if (entries.some((entry) => entry.phase === "running")) return EMBED_COLOR.pending;
  if (entries.some((entry) => entry.phase === "error")) return EMBED_COLOR.danger;
  return EMBED_COLOR.success;
};

export const createToolStatusComponents = (entries: readonly ToolStatusEntry[]): ContainerBuilder =>
  new ContainerBuilder()
    .setAccentColor(groupColor(entries))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**Tools**"),
      ...entries.map((entry) => new TextDisplayBuilder().setContent(formatEntry(entry))),
    );
