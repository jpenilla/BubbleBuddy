import { EmbedBuilder } from "discord.js";

export interface ToolStatusEmbed {
  readonly phase: "start" | "success" | "error";
  readonly toolCallId: string;
  readonly toolName: string;
}

const TOOL_STATUS_EMOJI = {
  start: "🛠️",
  success: "✅",
  error: "❌",
} as const;

const TOOL_STATUS_LABEL = {
  start: "Running",
  success: "Completed",
  error: "Failed",
} as const;

const TOOL_STATUS_COLOR = {
  start: 0xf1c40f,
  success: 0x2ecc71,
  error: 0xe74c3c,
} as const;

export const createToolStatusEmbed = (status: ToolStatusEmbed): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(TOOL_STATUS_COLOR[status.phase])
    .setDescription(
      `${TOOL_STATUS_EMOJI[status.phase]} ${TOOL_STATUS_LABEL[status.phase]} \`${status.toolName}\``,
    );
