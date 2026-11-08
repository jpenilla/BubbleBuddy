import { EmbedBuilder } from "discord.js";

import { DISCORD_EMBED_DESCRIPTION_LIMIT } from "../../../shared/constants.ts";
import { truncate } from "../../../shared/text.ts";
import { EMBED_COLOR } from "../../utils.ts";
import { type CompactionProgress } from "../state.ts";

const phaseColor = (phase: CompactionProgress["phase"]): number => {
  switch (phase) {
    case "running":
    case "settling":
      return EMBED_COLOR.pending;
    case "success":
      return EMBED_COLOR.success;
    case "error":
    case "aborted":
      return EMBED_COLOR.danger;
  }
};

const formatBackgroundDescription = (status: CompactionProgress): string => {
  switch (status.phase) {
    case "running":
    case "settling":
      return status.reason === "manual"
        ? "⏳ 🗜️ **Compacting context in the background**"
        : "⏳ 🗜️ **Auto-compacting context in the background**";
    case "success":
      return "✅ 🗜️ **Background compaction completed**";
    case "error":
      return `❌ 🗜️ **Background compaction failed**\n${status.errorMessage}`;
    case "aborted":
      return "❌ 🗜️ **Background compaction cancelled**";
  }
};

const formatDescription = (status: CompactionProgress): string => {
  if (status.background) return formatBackgroundDescription(status);
  switch (status.phase) {
    case "running":
    case "settling":
      if (status.reason === "manual") {
        return "⏳ 🗜️ **Compacting context**";
      }
      return status.reason === "overflow"
        ? "⏳ 🗜️ **Context overflow detected; auto-compacting**"
        : "⏳ 🗜️ **Auto-compacting context**";
    case "success":
      return "✅ 🗜️ **Compaction completed**";
    case "error":
      return `❌ 🗜️ **Compaction failed**\n${status.errorMessage}`;
    case "aborted":
      return "❌ 🗜️ **Compaction cancelled**";
  }
};

export const make = (status: CompactionProgress): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(phaseColor(status.phase))
    .setDescription(truncate(formatDescription(status), DISCORD_EMBED_DESCRIPTION_LIMIT));

export * as CompactionCard from "./compaction.ts";
