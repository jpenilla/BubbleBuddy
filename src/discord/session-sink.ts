import type {
  GuildTextBasedChannel,
  Message,
  MessageMentionOptions,
  ReplyOptions,
} from "discord.js";
import { EmbedBuilder } from "discord.js";

import type { AppConfigShape } from "../config.ts";
import { type SessionSink } from "../pi/discord-output-pump.ts";
import {
  createCompactionStatusEmbed,
  type CompactionStatusEmbed,
} from "./compaction-status-embed.ts";
import {
  createRetryStatusEmbed,
  createRunAbortedEmbed,
  createRunErrorEmbed,
  type RetryStatusEmbed,
} from "./run-status-embed.ts";
import { createToolStatusEmbed, type ToolStatusEmbed } from "./tool-status-embed.ts";
import { splitDiscordMessage, splitThinkingStatus } from "../domain/text.ts";

const sendOrEditStatusCard = async (
  channel: GuildTextBasedChannel,
  existing: Message<true> | undefined,
  embed: EmbedBuilder,
): Promise<Message<true>> => {
  if (existing !== undefined) {
    await existing.edit({ embeds: [embed] });
    return existing;
  }

  return await channel.send({ embeds: [embed] });
};

const sendChunkedMessage = async (opts: {
  channel: GuildTextBasedChannel;
  content: string;
  reply?: ReplyOptions;
  allowedMentions?: MessageMentionOptions;
}): Promise<void> => {
  const chunks = splitDiscordMessage(opts.content);

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0 && opts.reply !== undefined) {
      await opts.channel.send({
        content: chunk,
        reply: opts.reply,
        allowedMentions: opts.allowedMentions,
      });
      continue;
    }

    await opts.channel.send({
      content: chunk,
      allowedMentions: opts.allowedMentions,
    });
  }
};

export const createSessionSink = (
  channel: GuildTextBasedChannel,
  config: AppConfigShape,
): SessionSink => {
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let compactionStatusMessage: Message<true> | undefined;
  let runRetryMessage: Message<true> | undefined;
  let toolStatusMessages = new Map<string, Message<true>>();

  const stopTypingLoop = (): void => {
    if (typingTimer !== undefined) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  };

  const resetRunToolStatusMessages = (): void => {
    toolStatusMessages = new Map<string, Message<true>>();
  };

  return {
    onCompactionStatus: async (status: CompactionStatusEmbed) => {
      const embed = createCompactionStatusEmbed(status);
      compactionStatusMessage = await sendOrEditStatusCard(channel, compactionStatusMessage, embed);
      if (status.phase !== "start") {
        compactionStatusMessage = undefined;
      }
    },
    onFinal: async (text: string, replyToMessageId: string) => {
      await sendChunkedMessage({
        channel,
        content: text,
        reply: {
          messageReference: replyToMessageId,
          failIfNotExists: false,
        },
      });
    },
    onIntermediate: async (text: string, replyToMessageId: string) => {
      await sendChunkedMessage({
        channel,
        content: text,
        reply: {
          messageReference: replyToMessageId,
          failIfNotExists: false,
        },
        allowedMentions: { repliedUser: false },
      });
    },
    onRetryStatus: async (status: RetryStatusEmbed) => {
      const embed = createRetryStatusEmbed(status);
      runRetryMessage = await sendOrEditStatusCard(channel, runRetryMessage, embed);
      if (status.phase === "success" || status.phase === "failure" || status.phase === "aborted") {
        runRetryMessage = undefined;
      }
    },
    onRunAborted: async () => {
      if (runRetryMessage !== undefined) {
        const embed = createRetryStatusEmbed({ phase: "aborted" });
        runRetryMessage = await sendOrEditStatusCard(channel, runRetryMessage, embed);
        runRetryMessage = undefined;
        return;
      }
      await channel.send({ embeds: [createRunAbortedEmbed()] });
    },
    onRunEnd: async () => {
      resetRunToolStatusMessages();
      stopTypingLoop();
    },
    onRunError: async (errorMessage: string) => {
      await channel.send({ embeds: [createRunErrorEmbed({ errorMessage })] });
    },
    onRunStart: async () => {
      resetRunToolStatusMessages();
      if (typingTimer !== undefined) {
        return;
      }

      await channel.sendTyping();
      typingTimer = setInterval(() => {
        void channel.sendTyping().catch(() => undefined);
      }, config.typingIndicatorIntervalMs);
    },
    onStatus: async (status: ToolStatusEmbed) => {
      const embed = createToolStatusEmbed(status);
      const existing = toolStatusMessages.get(status.toolCallId);
      const sent = await sendOrEditStatusCard(channel, existing, embed);
      if (status.phase === "start") {
        toolStatusMessages.set(status.toolCallId, sent);
      } else {
        toolStatusMessages.delete(status.toolCallId);
      }
    },
    onThinking: async (text: string) => {
      for (const chunk of splitThinkingStatus(text)) {
        await channel.send(chunk);
      }
    },
  };
};
