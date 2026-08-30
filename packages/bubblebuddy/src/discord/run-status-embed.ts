import { EmbedBuilder } from "discord.js";

import { truncateDiscordEmbedDescription } from "./response-formatting.ts";

export type RetryStatus =
  | { readonly phase: "retrying"; readonly attempt: number; readonly maxAttempts: number }
  | { readonly phase: "success"; readonly attempt: number }
  | { readonly phase: "failure"; readonly attempt: number; readonly finalError?: string }
  | { readonly phase: "aborted"; readonly attempt: number };

const COLOR = {
  abort: 0xe74c3c,
  error: 0xe74c3c,
  warning: 0xf1c40f,
  retrying: 0xf1c40f,
  success: 0x2ecc71,
  failure: 0xe74c3c,
} as const;

const formatAttempts = (attempt: number): string => `${attempt} attempt${attempt === 1 ? "" : "s"}`;

export const createRunAbortedEmbed = (): EmbedBuilder =>
  new EmbedBuilder().setColor(COLOR.abort).setDescription("🛑 **Run aborted**");

export const createRunErrorEmbed = (errorMessage: string): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(COLOR.error)
    .setDescription(truncateDiscordEmbedDescription(`❌ **Run failed**\n${errorMessage}`));

export const createModelRequestErrorEmbed = (errorMessage: string): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(COLOR.error)
    .setDescription(
      truncateDiscordEmbedDescription(`❌ **Model request failed**\n${errorMessage}`),
    );

export const createResponseTruncatedEmbed = (): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(COLOR.warning)
    .setDescription("⚠️ **Response was truncated before completion.**");

export const createRetryStatusEmbed = (status: RetryStatus): EmbedBuilder => {
  switch (status.phase) {
    case "retrying":
      return new EmbedBuilder()
        .setColor(COLOR.retrying)
        .setDescription(`🔄 **Retrying** (${status.attempt}/${status.maxAttempts})...`);
    case "success":
      return new EmbedBuilder()
        .setColor(COLOR.success)
        .setDescription(`✅ **Retry succeeded after ${formatAttempts(status.attempt)}**`);
    case "failure":
      return new EmbedBuilder()
        .setColor(COLOR.failure)
        .setDescription(
          truncateDiscordEmbedDescription(
            `❌ **Retry failed after ${formatAttempts(status.attempt)}**${
              status.finalError ? `\n${status.finalError}` : ""
            }`,
          ),
        );
    case "aborted":
      return new EmbedBuilder()
        .setColor(COLOR.abort)
        .setDescription(`🛑 **Retry aborted after ${formatAttempts(status.attempt)}**`);
  }
};
