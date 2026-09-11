import { EmbedBuilder } from "discord.js";

import { truncate } from "../shared/text.ts";
import { DISCORD_EMBED_DESCRIPTION_LIMIT } from "./response-formatting.ts";
import { EMBED_COLOR } from "./utils.ts";

export type RetryStatus =
  | { readonly phase: "retrying"; readonly attempt: number; readonly maxAttempts: number }
  | { readonly phase: "success"; readonly attempt: number }
  | { readonly phase: "failure"; readonly attempt: number; readonly finalError?: string }
  | { readonly phase: "aborted"; readonly attempt: number };

const formatAttempts = (attempt: number): string => `${attempt} attempt${attempt === 1 ? "" : "s"}`;

export const createRunAbortedEmbed = (): EmbedBuilder =>
  new EmbedBuilder().setColor(EMBED_COLOR.danger).setDescription("🛑 **Run aborted**");

export const createRunErrorEmbed = (errorMessage: string): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(EMBED_COLOR.danger)
    .setDescription(
      truncate(`❌ **Run failed**\n${errorMessage}`, DISCORD_EMBED_DESCRIPTION_LIMIT),
    );

export const createModelRequestErrorEmbed = (errorMessage: string): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(EMBED_COLOR.danger)
    .setDescription(
      truncate(`❌ **Model request failed**\n${errorMessage}`, DISCORD_EMBED_DESCRIPTION_LIMIT),
    );

export const createResponseTruncatedEmbed = (): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(EMBED_COLOR.danger)
    .setDescription("❌ **Response was truncated before completion.**");

export const createRetryStatusEmbed = (status: RetryStatus): EmbedBuilder => {
  switch (status.phase) {
    case "retrying":
      return new EmbedBuilder()
        .setColor(EMBED_COLOR.pending)
        .setDescription(`🔄 **Retrying** (${status.attempt}/${status.maxAttempts})...`);
    case "success":
      return new EmbedBuilder()
        .setColor(EMBED_COLOR.success)
        .setDescription(`✅ **Retry succeeded after ${formatAttempts(status.attempt)}**`);
    case "failure":
      return new EmbedBuilder()
        .setColor(EMBED_COLOR.danger)
        .setDescription(
          truncate(
            `❌ **Retry failed after ${formatAttempts(status.attempt)}**${
              status.finalError ? `\n${status.finalError}` : ""
            }`,
            DISCORD_EMBED_DESCRIPTION_LIMIT,
          ),
        );
    case "aborted":
      return new EmbedBuilder()
        .setColor(EMBED_COLOR.danger)
        .setDescription(`🛑 **Retry aborted after ${formatAttempts(status.attempt)}**`);
  }
};
