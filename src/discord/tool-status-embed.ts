import { EmbedBuilder } from "discord.js";

export interface ToolStatusEmbed {
  readonly phase: "start" | "end";
  readonly toolCallId: string;
  readonly toolName: string;
}

const TOOL_STATUS_EMOJI = {
  end: "✅",
  start: "🛠️",
} as const;

const TOOL_STATUS_LABEL = {
  end: "Completed",
  start: "Running",
} as const;

const TOOL_STATUS_COLOR = {
  end: 0x2ecc71,
  start: 0xf1c40f,
} as const;

export const createToolStatusEmbed = (status: ToolStatusEmbed): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(TOOL_STATUS_COLOR[status.phase])
    .setDescription(
      `${TOOL_STATUS_EMOJI[status.phase]} ${TOOL_STATUS_LABEL[status.phase]} \`${status.toolName}\``,
    );
