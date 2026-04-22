import { EmbedBuilder } from "discord.js";

export interface ToolStatusEmbed {
  readonly phase: "start" | "end";
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

export const createToolStatusEmbed = (status: ToolStatusEmbed): EmbedBuilder =>
  new EmbedBuilder().setDescription(
    `${TOOL_STATUS_EMOJI[status.phase]} ${TOOL_STATUS_LABEL[status.phase]} \`${status.toolName}\``,
  );
