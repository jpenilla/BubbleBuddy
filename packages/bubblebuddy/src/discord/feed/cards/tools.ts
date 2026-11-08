import { ContainerBuilder, TextDisplayBuilder } from "discord.js";

import { inlineCode } from "../../../shared/markdown.ts";
import { EMBED_COLOR } from "../../utils.ts";
import { type ToolRow } from "../state.ts";

const TOOL_STATUS_EMOJI = {
  running: "⏳",
  success: "✅",
  error: "❌",
} as const;

const formatRow = (row: ToolRow): string => {
  const heading = `${TOOL_STATUS_EMOJI[row.phase]} **${row.toolName}**`;
  return row.description === undefined ? heading : `${heading}\n${inlineCode(row.description)}`;
};

export const make = (rows: readonly ToolRow[]): ContainerBuilder =>
  new ContainerBuilder()
    .setAccentColor(EMBED_COLOR.neutral)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("🛠️ **Tools**"),
      ...rows.map((row) => new TextDisplayBuilder().setContent(formatRow(row))),
    );

export * as ToolsCard from "./tools.ts";
