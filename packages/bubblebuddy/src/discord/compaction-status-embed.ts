import { EmbedBuilder } from "discord.js";

export interface CompactionStatusEmbed {
  readonly phase: "start" | "success" | "error" | "aborted";
  readonly reason: "manual" | "threshold" | "overflow";
  readonly tokensBefore?: number;
}

const COMPACTION_STATUS_COLOR = {
  start: 0xf1c40f,
  success: 0x2ecc71,
  error: 0xe74c3c,
  aborted: 0xe74c3c,
} as const;

const formatDescription = (status: CompactionStatusEmbed): string => {
  switch (status.phase) {
    case "start":
      return status.reason === "manual"
        ? "🗜️ **Compacting context** ⏳"
        : "🗜️ **Auto-compacting context** ⏳";
    case "success":
      return status.tokensBefore === undefined
        ? "🗜️ **Compaction completed** ✅"
        : `🗜️ **Compaction completed** ✅\nCompacted from ${status.tokensBefore.toLocaleString()} tokens.`;
    case "error":
      return "🗜️ **Compaction failed** ❌";
    case "aborted":
      return "🗜️ **Compaction cancelled** ❌";
  }
};

export const createCompactionStatusEmbed = (status: CompactionStatusEmbed): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(COMPACTION_STATUS_COLOR[status.phase])
    .setDescription(formatDescription(status));
