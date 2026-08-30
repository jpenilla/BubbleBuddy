import { EmbedBuilder } from "discord.js";

import { truncateDiscordEmbedDescription } from "./response-formatting.ts";

type CompactionReason = "manual" | "threshold" | "overflow";

export type CompactionStatus =
  | { readonly phase: "start"; readonly reason: CompactionReason }
  | { readonly phase: "success"; readonly reason: CompactionReason; readonly tokensBefore?: number }
  | { readonly phase: "error"; readonly reason: CompactionReason; readonly errorMessage?: string }
  | { readonly phase: "aborted"; readonly reason: CompactionReason };

const COLOR = {
  start: 0xf1c40f,
  success: 0x2ecc71,
  error: 0xe74c3c,
  aborted: 0xe74c3c,
} as const;

const formatErrorDetail = (errorMessage: string | undefined): string | undefined => {
  const detail = errorMessage?.replace(/^Compaction failed:\s*/i, "").trim();
  return detail && detail.length > 0 ? detail : undefined;
};

const formatDescription = (status: CompactionStatus): string => {
  switch (status.phase) {
    case "start":
      if (status.reason === "manual") {
        return "🗜️ **Compacting context** ⏳";
      }
      return status.reason === "overflow"
        ? "🗜️ **Context overflow detected; auto-compacting** ⏳"
        : "🗜️ **Auto-compacting context** ⏳";
    case "success":
      return status.tokensBefore === undefined
        ? "🗜️ **Compaction completed** ✅"
        : `🗜️ **Compaction completed** ✅\nCompacted from ${status.tokensBefore.toLocaleString()} tokens.`;
    case "error": {
      const detail = formatErrorDetail(status.errorMessage);
      return `🗜️ **Compaction failed** ❌${detail === undefined ? "" : `\n${detail}`}`;
    }
    case "aborted":
      return "🗜️ **Compaction cancelled** ❌";
  }
};

export const createCompactionStatusEmbed = (status: CompactionStatus): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(COLOR[status.phase])
    .setDescription(truncateDiscordEmbedDescription(formatDescription(status)));
