import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { Deferred, Effect, Scope } from "effect";

import type { AppConfigShape } from "../config.ts";
import {
  createCompactionStatusEmbed,
  type CompactionStatusEmbed,
} from "../discord/compaction-status-embed.ts";
import {
  createRetryStatusEmbed,
  createRunAbortedEmbed,
  createRunErrorEmbed,
  type RetryStatusEmbed,
} from "../discord/run-status-embed.ts";
import { createToolStatusEmbed, type ToolStatusEmbed } from "../discord/tool-status-embed.ts";
import { sendChunkedMessage, sendOrEditStatusCard } from "../discord/utils.ts";
import { extractAssistantText, splitThinkingStatus } from "../domain/text.ts";
import { makePriorityDrainableWorker } from "./priority-drainable-worker.ts";

export type RunDiscordAction = <T>(
  operation: Effect.Effect<T, unknown>,
) => Effect.Effect<T, unknown>;

export interface DiscordOutputPump {
  readonly handleSessionEvent: (event: AgentSessionEvent) => void;
  readonly reportUnexpectedError: (error: unknown) => void;
  readonly runDiscordAction: RunDiscordAction;
  readonly setReplyToMessageId: (replyToMessageId: string) => void;
  readonly shutdown: Effect.Effect<void>;
}

interface DiscordOutputPumpOptions {
  readonly channel: GuildTextBasedChannel;
  readonly config: AppConfigShape;
  readonly getShowThinking: () => boolean;
}

const SUPPRESSED_TOOL_STATUS = new Set([
  "discord_list_custom_emojis",
  "discord_list_stickers",
  "discord_fetch_message",
  "discord_react",
  "discord_send_sticker",
  "discord_upload_file",
]);

const formatUnexpectedError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0
    ? `The model request failed: ${error.message}`
    : "The model request failed.";

export const makeDiscordOutputPump = (
  options: DiscordOutputPumpOptions,
): Effect.Effect<DiscordOutputPump, never, Scope.Scope> =>
  Effect.gen(function* () {
    const worker = yield* makePriorityDrainableWorker((job: Effect.Effect<void>) =>
      job.pipe(Effect.ignore({ log: "Warn", message: "Discord output action failed" })),
    );
    const channel = options.channel;
    const config = options.config;
    const getShowThinking = options.getShowThinking;
    const ctx = yield* Effect.context();

    let latestTriggerMessageId = "";
    let currentTurnReplyTo = "";
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

    const resetRunState = (): void => {
      resetRunToolStatusMessages();
      stopTypingLoop();
    };

    const enqueueStatusAction = (job: Effect.Effect<void>): void => {
      void Effect.runForkWith(ctx)(worker.enqueueHigh(job).pipe(Effect.ignore));
    };

    const onCompactionStatus = async (status: CompactionStatusEmbed): Promise<void> => {
      const embed = createCompactionStatusEmbed(status);
      compactionStatusMessage = await sendOrEditStatusCard(channel, compactionStatusMessage, embed);
      if (status.phase !== "start") {
        compactionStatusMessage = undefined;
      }
    };

    const onFinal = async (text: string, replyToMessageId: string): Promise<void> => {
      await sendChunkedMessage({
        channel,
        content: text,
        reply: {
          messageReference: replyToMessageId,
          failIfNotExists: false,
        },
      });
    };

    const onIntermediate = async (text: string, replyToMessageId: string): Promise<void> => {
      await sendChunkedMessage({
        channel,
        content: text,
        reply: {
          messageReference: replyToMessageId,
          failIfNotExists: false,
        },
        allowedMentions: { repliedUser: false },
      });
    };

    const onRetryStatus = async (status: RetryStatusEmbed): Promise<void> => {
      const embed = createRetryStatusEmbed(status);
      runRetryMessage = await sendOrEditStatusCard(channel, runRetryMessage, embed);
      if (status.phase === "success" || status.phase === "failure" || status.phase === "aborted") {
        runRetryMessage = undefined;
      }
    };

    const onRunAborted = async (): Promise<void> => {
      if (runRetryMessage !== undefined) {
        const embed = createRetryStatusEmbed({ phase: "aborted" });
        runRetryMessage = await sendOrEditStatusCard(channel, runRetryMessage, embed);
        runRetryMessage = undefined;
        return;
      }
      await channel.send({ embeds: [createRunAbortedEmbed()] });
    };

    const onRunError = async (errorMessage: string): Promise<void> => {
      await channel.send({ embeds: [createRunErrorEmbed({ errorMessage })] });
    };

    const onRunStart = async (): Promise<void> => {
      resetRunToolStatusMessages();
      if (typingTimer !== undefined) {
        return;
      }

      await channel.sendTyping();
      typingTimer = setInterval(() => {
        void channel.sendTyping().catch(() => undefined);
      }, config.typingIndicatorIntervalMs);
    };

    const onStatus = async (status: ToolStatusEmbed): Promise<void> => {
      const embed = createToolStatusEmbed(status);
      const existing = toolStatusMessages.get(status.toolCallId);
      const sent = await sendOrEditStatusCard(channel, existing, embed);
      if (status.phase === "start") {
        toolStatusMessages.set(status.toolCallId, sent);
      } else {
        toolStatusMessages.delete(status.toolCallId);
      }
    };

    const onThinking = async (text: string): Promise<void> => {
      for (const chunk of splitThinkingStatus(text)) {
        await channel.send(chunk);
      }
    };

    const setReplyToMessageId = (replyToMessageId: string): void => {
      latestTriggerMessageId = replyToMessageId;
    };

    const handleSessionEvent = (event: AgentSessionEvent): void => {
      switch (event.type) {
        case "agent_start":
          enqueueStatusAction(Effect.tryPromise(() => onRunStart()));
          break;
        case "agent_end":
          enqueueStatusAction(Effect.sync(resetRunState));
          break;
        case "turn_start":
          currentTurnReplyTo = latestTriggerMessageId;
          break;
        case "compaction_start":
          enqueueStatusAction(
            Effect.tryPromise(() =>
              onCompactionStatus({
                phase: "start",
                reason: event.reason,
              }),
            ),
          );
          break;
        case "compaction_end":
          if (event.errorMessage !== undefined) {
            void Effect.runForkWith(ctx)(Effect.logWarning(event.errorMessage));
          }
          enqueueStatusAction(
            Effect.tryPromise(() =>
              onCompactionStatus({
                phase: event.aborted ? "aborted" : event.result === undefined ? "error" : "success",
                reason: event.reason,
                tokensBefore: event.result?.tokensBefore,
              }),
            ),
          );
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            const msg = event.message;
            if (msg.stopReason === "error") {
              enqueueStatusAction(
                Effect.tryPromise(() =>
                  onRunError(msg.errorMessage ?? "The model request failed."),
                ),
              );
              break;
            }
            if (msg.stopReason === "aborted") {
              enqueueStatusAction(Effect.tryPromise(() => onRunAborted()));
              break;
            }
            const text = extractAssistantText(msg);
            if (text.trim().length === 0) {
              break;
            }
            if (msg.stopReason === "toolUse") {
              enqueueStatusAction(
                Effect.tryPromise(() => onIntermediate(text, currentTurnReplyTo)),
              );
            } else {
              enqueueStatusAction(Effect.tryPromise(() => onFinal(text, currentTurnReplyTo)));
            }
          }
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "thinking_end") {
            if (getShowThinking()) {
              const thinking = event.assistantMessageEvent.content.trim();
              if (thinking.length > 0) {
                enqueueStatusAction(Effect.tryPromise(() => onThinking(thinking)));
              }
            }
          }
          break;
        case "tool_execution_end":
        case "tool_execution_start":
          if (!SUPPRESSED_TOOL_STATUS.has(event.toolName)) {
            enqueueStatusAction(
              Effect.tryPromise(() =>
                onStatus({
                  phase:
                    event.type === "tool_execution_start"
                      ? "start"
                      : event.isError
                        ? "error"
                        : "success",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                }),
              ),
            );
          }
          break;
        case "auto_retry_start":
          enqueueStatusAction(
            Effect.tryPromise(() =>
              onRetryStatus({
                phase: "retrying",
                attempt: event.attempt,
              }),
            ),
          );
          break;
        case "auto_retry_end":
          enqueueStatusAction(
            Effect.tryPromise(() =>
              onRetryStatus(
                event.success
                  ? { phase: "success" }
                  : { phase: "failure", finalError: event.finalError },
              ),
            ),
          );
          break;
      }
    };

    const reportUnexpectedError = (error: unknown): void => {
      enqueueStatusAction(Effect.tryPromise(() => onRunError(formatUnexpectedError(error))));
    };

    const runDiscordAction: RunDiscordAction = <T>(operation: Effect.Effect<T, unknown>) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<T, unknown>();
        yield* worker.enqueueLow(Deferred.completeWith(deferred, operation));
        return yield* Deferred.await(deferred);
      });

    const shutdown = Effect.gen(function* () {
      yield* worker.drain;
      yield* Effect.sync(resetRunState);
    });

    return {
      handleSessionEvent,
      reportUnexpectedError,
      runDiscordAction,
      setReplyToMessageId,
      shutdown,
    };
  });
