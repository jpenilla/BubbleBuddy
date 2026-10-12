import { type CompactionReason } from "@earendil-works/pi-durable";
import { EmbedBuilder } from "discord.js";

import { DISCORD_EMBED_DESCRIPTION_LIMIT } from "../shared/constants.ts";
import { truncate } from "../shared/text.ts";
import { EMBED_COLOR } from "./utils.ts";

export type CompactionStatus = {
  readonly reason: CompactionReason;
  /** Runs while the conversation keeps working, instead of holding it up. */
  readonly background: boolean;
} & (
  | { readonly phase: "start" | "success" | "aborted" }
  | { readonly phase: "error"; readonly errorMessage?: string }
);

const phaseColor = (phase: CompactionStatus["phase"]): number => {
  switch (phase) {
    case "start":
      return EMBED_COLOR.pending;
    case "success":
      return EMBED_COLOR.success;
    case "error":
    case "aborted":
      return EMBED_COLOR.danger;
  }
};

const formatErrorDetail = (errorMessage: string | undefined): string | undefined => {
  const detail = errorMessage?.replace(/^Compaction failed:\s*/i, "").trim();
  return detail && detail.length > 0 ? detail : undefined;
};

const formatBackgroundDescription = (status: CompactionStatus): string => {
  switch (status.phase) {
    case "start":
      return status.reason === "manual"
        ? "⏳ 🗜️ **Compacting context in the background**"
        : "⏳ 🗜️ **Auto-compacting context in the background**";
    case "success":
      return "✅ 🗜️ **Background compaction completed**";
    case "error": {
      const detail = formatErrorDetail(status.errorMessage);
      return `❌ 🗜️ **Background compaction failed**${detail === undefined ? "" : `\n${detail}`}`;
    }
    case "aborted":
      return "❌ 🗜️ **Background compaction cancelled**";
  }
};

const formatDescription = (status: CompactionStatus): string => {
  if (status.background) return formatBackgroundDescription(status);
  switch (status.phase) {
    case "start":
      if (status.reason === "manual") {
        return "⏳ 🗜️ **Compacting context**";
      }
      return status.reason === "overflow"
        ? "⏳ 🗜️ **Context overflow detected; auto-compacting**"
        : "⏳ 🗜️ **Auto-compacting context**";
    case "success":
      return "✅ 🗜️ **Compaction completed**";
    case "error": {
      const detail = formatErrorDetail(status.errorMessage);
      return `❌ 🗜️ **Compaction failed**${detail === undefined ? "" : `\n${detail}`}`;
    }
    case "aborted":
      return "❌ 🗜️ **Compaction cancelled**";
  }
};

export const createCompactionStatusEmbed = (status: CompactionStatus): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(phaseColor(status.phase))
    .setDescription(truncate(formatDescription(status), DISCORD_EMBED_DESCRIPTION_LIMIT));
