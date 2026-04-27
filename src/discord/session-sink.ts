import type { GuildTextBasedChannel, Message } from "discord.js";

import type { AppConfigShape } from "../config.ts";
import { ChannelState } from "../channel-state.ts";
import { type SessionSink } from "../pi/discord-output-pump.ts";
import { createToolStatusEmbed, type ToolStatusEmbed } from "./tool-status-embed.ts";
import { splitDiscordMessage, splitThinkingStatus } from "../domain/text.ts";

const sendChunkedMessage = async (
  channel: GuildTextBasedChannel,
  content: string,
  replyToMessageId?: string,
): Promise<void> => {
  const chunks = splitDiscordMessage(content);

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0 && replyToMessageId !== undefined) {
      await channel.send({
        content: chunk,
        reply: {
          failIfNotExists: false,
          messageReference: replyToMessageId,
        },
      });
      continue;
    }

    await channel.send(chunk);
  }
};

export const createSessionSink = (
  channel: GuildTextBasedChannel,
  config: AppConfigShape,
  channelState: ChannelState,
): SessionSink => {
  let typingTimer: ReturnType<typeof setInterval> | undefined;
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
    onError: async (text: string) => {
      await sendChunkedMessage(channel, text);
    },
    onFinal: async (text: string, replyToMessageId: string) => {
      await sendChunkedMessage(channel, text, replyToMessageId);
    },
    onThinking: async (text: string) => {
      for (const chunk of splitThinkingStatus(text)) {
        await channel.send(chunk);
      }
    },
    onRunEnd: async () => {
      resetRunToolStatusMessages();
      stopTypingLoop();
      channelState.touchActivity();
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
      if (existing !== undefined) {
        await existing.edit({ embeds: [embed] });
        if (status.phase === "success" || status.phase === "error") {
          toolStatusMessages.delete(status.toolCallId);
        }
        return;
      }

      const sent = await channel.send({ embeds: [embed] });
      if (status.phase === "start") {
        toolStatusMessages.set(status.toolCallId, sent);
      }
    },
  };
};
