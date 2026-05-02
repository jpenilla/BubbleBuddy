import { EmbedBuilder } from "discord.js";

export type RetryStatusEmbed =
  | { readonly phase: "retrying"; readonly attempt: number }
  | { readonly phase: "success" }
  | { readonly phase: "failure"; readonly finalError?: string }
  | { readonly phase: "aborted" };

export interface RunErrorEmbed {
  readonly errorMessage: string;
}

const COLOR = {
  abort: 0xe74c3c,
  error: 0xe74c3c,
  retrying: 0xf1c40f,
  success: 0x2ecc71,
  failure: 0xe74c3c,
} as const;

export const createRunAbortedEmbed = (): EmbedBuilder =>
  new EmbedBuilder().setColor(COLOR.abort).setDescription("🛑 **Run aborted**");

export const createRunErrorEmbed = (status: RunErrorEmbed): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(COLOR.error)
    .setDescription(`❌ **Run failed**\n${status.errorMessage}`);

export const createRetryStatusEmbed = (status: RetryStatusEmbed): EmbedBuilder => {
  switch (status.phase) {
    case "retrying":
      return new EmbedBuilder()
        .setColor(COLOR.retrying)
        .setDescription(`🔄 **Retrying** (attempt ${status.attempt})`);
    case "success":
      return new EmbedBuilder().setColor(COLOR.success).setDescription(`✅ **Retry succeeded**`);
    case "failure":
      return new EmbedBuilder()
        .setColor(COLOR.failure)
        .setDescription(`❌ **Retry failed**${status.finalError ? ` — ${status.finalError}` : ""}`);
    case "aborted":
      return new EmbedBuilder().setColor(COLOR.abort).setDescription(`🛑 **Retry aborted**`);
  }
};
