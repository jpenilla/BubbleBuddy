import { EmbedBuilder } from "discord.js";

import { EMBED_COLOR } from "./utils.ts";

export interface ToolStatusEmbed {
  readonly phase: "start" | "success" | "error";
  readonly toolCallId: string;
  readonly toolName: string;
}

const TOOL_EMOJI = "🛠️" as const;

const TOOL_STATUS_EMOJI = {
  start: "⏳",
  success: "✅",
  error: "❌",
} as const;

const phaseColor = (phase: ToolStatusEmbed["phase"]): number => {
  switch (phase) {
    case "start":
      return EMBED_COLOR.pending;
    case "success":
      return EMBED_COLOR.success;
    case "error":
      return EMBED_COLOR.danger;
  }
};

export const createToolStatusEmbed = (status: ToolStatusEmbed): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(phaseColor(status.phase))
    .setDescription(`${TOOL_EMOJI} **${status.toolName}** ${TOOL_STATUS_EMOJI[status.phase]}`);
