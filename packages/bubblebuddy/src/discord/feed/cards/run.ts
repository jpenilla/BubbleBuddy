import { DEFAULT_RETRY_POLICY } from "@earendil-works/pi-durable";
import { EmbedBuilder } from "discord.js";

import { DISCORD_EMBED_DESCRIPTION_LIMIT } from "../../../shared/constants.ts";
import { collapseWhitespace, truncate } from "../../../shared/text.ts";
import { EMBED_COLOR } from "../../utils.ts";
import { type RetryStatus } from "../state.ts";

const RETRY_ERROR_PREFIX = "\n- ";

/** The header, then each error on its own line with an equal share of the space the header leaves. */
const formatRetryCard = (header: string, errors: readonly string[]): string => {
  const limit =
    Math.floor((DISCORD_EMBED_DESCRIPTION_LIMIT - header.length) / Math.max(1, errors.length)) -
    RETRY_ERROR_PREFIX.length;
  return (
    header +
    errors.map((error) => RETRY_ERROR_PREFIX + truncate(collapseWhitespace(error), limit)).join("")
  );
};

const formatAttempts = (attempt: number): string => `${attempt} attempt${attempt === 1 ? "" : "s"}`;

export const aborted = (): EmbedBuilder =>
  new EmbedBuilder().setColor(EMBED_COLOR.danger).setDescription("🛑 **Run aborted**");

export const modelError = (errorMessage: string): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(EMBED_COLOR.danger)
    .setDescription(
      truncate(`❌ **Model request failed**\n${errorMessage}`, DISCORD_EMBED_DESCRIPTION_LIMIT),
    );

export const truncated = (): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(EMBED_COLOR.danger)
    .setDescription("❌ **Response was truncated before completion.**");

const retryCardHeader = (status: RetryStatus): readonly [number, string] => {
  switch (status.phase) {
    case "retrying":
      return [
        EMBED_COLOR.pending,
        `🔄 **Retrying** (${status.attempt}/${DEFAULT_RETRY_POLICY.maxRetries})...`,
      ];
    case "success":
      return [
        EMBED_COLOR.success,
        `✅ **Retry succeeded after ${formatAttempts(status.attempt)}**`,
      ];
    case "failure":
      return [EMBED_COLOR.danger, `❌ **Retry failed after ${formatAttempts(status.attempt)}**`];
    case "aborted":
      return [EMBED_COLOR.danger, `🛑 **Retry aborted after ${formatAttempts(status.attempt)}**`];
  }
};

export const retry = (status: RetryStatus): EmbedBuilder => {
  const [color, header] = retryCardHeader(status);
  return new EmbedBuilder().setColor(color).setDescription(formatRetryCard(header, status.errors));
};

export * as RunCard from "./run.ts";
