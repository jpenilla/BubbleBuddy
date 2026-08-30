import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { Deferred, Effect, MutableRef, Scope } from "effect";

import { createTypingIndicator } from "../discord/typing-indicator.ts";

import {
  createCompactionStatusEmbed,
  type CompactionStatus,
} from "../discord/compaction-status-embed.ts";
import {
  createModelRequestErrorEmbed,
  createRetryStatusEmbed,
  createResponseTruncatedEmbed,
  createRunAbortedEmbed,
  createRunErrorEmbed,
  type RetryStatus,
} from "../discord/run-status-embed.ts";
import { createToolStatusEmbed, type ToolStatusEmbed } from "../discord/tool-status-embed.ts";
import { sendChunkedMessage, sendOrEditStatusCard, tryDiscordJsPromise } from "../discord/utils.ts";
import { createPriorityDrainableWorker } from "../shared/priority-drainable-worker.ts";
import { extractAssistantText, splitThinkingStatus } from "../discord/response-formatting.ts";

export type ExecuteOrderedDiscordAction = <A, E>(
  operation: Effect.Effect<A, E>,
) => Effect.Effect<A, E>;

export interface DiscordOutputPump {
  readonly handleSessionEvent: (event: AgentSessionEvent) => void;
  readonly reportUnexpectedError: (error: unknown) => void;
  readonly executeOrdered: ExecuteOrderedDiscordAction;
  readonly pushActivationMessageId: (messageId: string) => void;
}

interface CreateDiscordOutputPumpInput {
  readonly channel: GuildTextBasedChannel;
  readonly showThinking: Effect.Effect<boolean>;
}

const SUPPRESSED_TOOL_STATUS = new Set([
  "discord_list_custom_emojis",
  "discord_list_stickers",
  "discord_fetch_message",
  "discord_react",
  "discord_save_attachments",
  "discord_send_sticker",
  "discord_upload_file",
]);

const formatUnexpectedError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0
    ? `The model request failed: ${error.message}`
    : "The model request failed.";

type SessionEvent<Type extends AgentSessionEvent["type"]> = Extract<
  AgentSessionEvent,
  { type: Type }
>;

interface RetryStatusState {
  readonly message: Message<true>;
  readonly attempt: number;
}

export const createDiscordOutputPump = (
  input: CreateDiscordOutputPumpInput,
): Effect.Effect<DiscordOutputPump, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outputWorker = yield* createPriorityDrainableWorker(
      (operation: Effect.Effect<void, unknown>) =>
        operation.pipe(
          Effect.ignore({
            log: "Warn",
            message: `Discord output action failed for channel ${input.channel.id}`,
          }),
        ),
    );
    const channel = input.channel;
    const runtimeContext = yield* Effect.context();
    const typingIndicator = yield* createTypingIndicator({ channel });

    const latestTriggerMessageId = MutableRef.make("");
    let currentTurnReplyTo = "";
    let compactionStatusMessage: Message<true> | undefined;
    let retryStatusState: RetryStatusState | undefined;
    const toolStatusMessages = new Map<string, Message<true>>();

    const enqueueOutput = (operation: Effect.Effect<void, unknown>): void => {
      void Effect.runForkWith(runtimeContext)(
        outputWorker.enqueueHigh(operation).pipe(Effect.ignore),
      );
    };

    const executeOrdered: ExecuteOrderedDiscordAction = Effect.fn(
      "DiscordOutputPump.executeOrdered",
    )(function* <A, E>(operation: Effect.Effect<A, E>) {
      const result = yield* Deferred.make<A, E>();
      const canceled = yield* Deferred.make<void>();
      const queuedOperation = operation.pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(result, exit)),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(canceled)),
      );

      return yield* outputWorker.enqueueLow(queuedOperation).pipe(
        Effect.andThen(Deferred.await(result)),
        Effect.onInterrupt(() => Deferred.succeed(canceled, undefined)),
      );
    });

    const sendCompactionStatus = (status: CompactionStatus) =>
      Effect.gen(function* () {
        const embed = createCompactionStatusEmbed(status);
        const sent = yield* tryDiscordJsPromise(() =>
          sendOrEditStatusCard(channel, compactionStatusMessage, embed),
        );
        compactionStatusMessage = status.phase === "start" ? sent : undefined;
      });

    const sendFinal = (text: string, replyToMessageId: string) =>
      tryDiscordJsPromise(() =>
        sendChunkedMessage({
          channel,
          content: text,
          reply: {
            messageReference: replyToMessageId,
            failIfNotExists: false,
          },
        }),
      );

    const sendIntermediate = (text: string, replyToMessageId: string) =>
      tryDiscordJsPromise(() =>
        sendChunkedMessage({
          channel,
          content: text,
          reply: {
            messageReference: replyToMessageId,
            failIfNotExists: false,
          },
          allowedMentions: { repliedUser: false },
        }),
      );

    const startRetryStatus = (status: Extract<RetryStatus, { phase: "retrying" }>) =>
      Effect.gen(function* () {
        const embed = createRetryStatusEmbed(status);
        const sent = yield* tryDiscordJsPromise(() =>
          sendOrEditStatusCard(channel, retryStatusState?.message, embed),
        );
        retryStatusState = { message: sent, attempt: status.attempt };
      });

    const finishRetryStatus = (status: Extract<RetryStatus, { phase: "success" | "failure" }>) =>
      Effect.gen(function* () {
        const current = retryStatusState;
        if (status.phase === "success" && current === undefined) {
          return;
        }
        yield* tryDiscordJsPromise(() =>
          sendOrEditStatusCard(channel, current?.message, createRetryStatusEmbed(status)),
        );
        retryStatusState = undefined;
      });

    const sendRunAborted = () =>
      Effect.gen(function* () {
        const current = retryStatusState;
        if (current !== undefined) {
          const embed = createRetryStatusEmbed({
            phase: "aborted",
            attempt: current.attempt,
          });
          yield* tryDiscordJsPromise(() => sendOrEditStatusCard(channel, current.message, embed));
          retryStatusState = undefined;
          return;
        }
        yield* tryDiscordJsPromise(() => channel.send({ embeds: [createRunAbortedEmbed()] }));
      });

    const sendModelRequestError = (errorMessage: string) =>
      tryDiscordJsPromise(() =>
        channel.send({ embeds: [createModelRequestErrorEmbed(errorMessage)] }),
      ).pipe(Effect.asVoid);

    const sendResponseTruncated = tryDiscordJsPromise(() =>
      channel.send({ embeds: [createResponseTruncatedEmbed()] }),
    ).pipe(Effect.asVoid);

    const sendRunError = (errorMessage: string) =>
      tryDiscordJsPromise(() => channel.send({ embeds: [createRunErrorEmbed(errorMessage)] })).pipe(
        Effect.asVoid,
      );

    const sendToolStatus = (status: ToolStatusEmbed) =>
      Effect.gen(function* () {
        const embed = createToolStatusEmbed(status);
        const sent = yield* tryDiscordJsPromise(() =>
          sendOrEditStatusCard(channel, toolStatusMessages.get(status.toolCallId), embed),
        );
        if (status.phase === "start") {
          toolStatusMessages.set(status.toolCallId, sent);
        } else {
          toolStatusMessages.delete(status.toolCallId);
        }
      });

    const sendThinking = (text: string) =>
      Effect.forEach(splitThinkingStatus(text), (chunk) =>
        tryDiscordJsPromise(() => channel.send(chunk)),
      ).pipe(Effect.asVoid);

    const onAgentSettled = Effect.gen(function* () {
      currentTurnReplyTo = "";
      retryStatusState = undefined;
      toolStatusMessages.clear();
      yield* typingIndicator.deactivate;
    });

    const onCompactionStart = (event: SessionEvent<"compaction_start">) =>
      sendCompactionStatus({
        phase: "start",
        reason: event.reason,
      });

    const onCompactionEnd = (event: SessionEvent<"compaction_end">) =>
      Effect.gen(function* () {
        if (event.errorMessage !== undefined) {
          yield* Effect.logWarning("Compaction failed", {
            channelId: input.channel.id,
            reason: event.reason,
            willRetry: event.willRetry,
            errorMessage: event.errorMessage,
          });
        }
        if (event.aborted) {
          yield* sendCompactionStatus({ phase: "aborted", reason: event.reason });
        } else if (event.result === undefined) {
          yield* sendCompactionStatus({
            phase: "error",
            reason: event.reason,
            errorMessage: event.errorMessage,
          });
        } else {
          yield* sendCompactionStatus({
            phase: "success",
            reason: event.reason,
            tokensBefore: event.result.tokensBefore,
          });
        }
      });

    const onMessageStart = (event: SessionEvent<"message_start">) =>
      event.message.role === "assistant" && event.message.stopReason === "pending"
        ? typingIndicator.activate
        : Effect.void;

    const onMessageEnd = (event: SessionEvent<"message_end">) =>
      Effect.gen(function* () {
        if (event.message.role !== "assistant") {
          return;
        }

        yield* typingIndicator.deactivate;
        const msg = event.message;
        const text = extractAssistantText(msg);
        if (text.trim().length > 0) {
          if (msg.stopReason === "stop" || msg.stopReason === "deferred") {
            yield* sendFinal(text, currentTurnReplyTo);
          } else {
            yield* sendIntermediate(text, currentTurnReplyTo);
          }
        }

        switch (msg.stopReason) {
          case "error":
            yield* sendModelRequestError(
              msg.errorMessage ?? "The model request failed without an error message.",
            );
            break;
          case "aborted":
            yield* sendRunAborted();
            break;
          case "length":
            yield* sendResponseTruncated;
            break;
        }
      });

    const onMessageUpdate = (event: SessionEvent<"message_update">) =>
      Effect.gen(function* () {
        if (event.assistantMessageEvent.type !== "thinking_end") {
          return;
        }
        const showThinking = yield* input.showThinking;
        if (!showThinking) {
          return;
        }
        const thinking = event.assistantMessageEvent.content.trim();
        if (thinking.length > 0) {
          yield* sendThinking(thinking).pipe(Effect.tap(() => typingIndicator.messageSent));
        }
      });

    const onToolExecution = (
      event: SessionEvent<"tool_execution_start"> | SessionEvent<"tool_execution_end">,
    ) => {
      if (SUPPRESSED_TOOL_STATUS.has(event.toolName)) {
        return Effect.void;
      }
      return sendToolStatus({
        phase:
          event.type === "tool_execution_start" ? "start" : event.isError ? "error" : "success",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    };

    const onAutoRetryStart = (event: SessionEvent<"auto_retry_start">) =>
      startRetryStatus({
        phase: "retrying",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      });

    const onAutoRetryEnd = (event: SessionEvent<"auto_retry_end">) =>
      finishRetryStatus(
        event.success
          ? { phase: "success", attempt: event.attempt }
          : {
              phase: "failure",
              attempt: event.attempt,
              finalError: event.finalError,
            },
      );

    const pushActivationMessageId = (messageId: string): void => {
      MutableRef.set(latestTriggerMessageId, messageId);
    };

    const handleSessionEvent = (event: AgentSessionEvent): void => {
      switch (event.type) {
        case "agent_settled":
          enqueueOutput(onAgentSettled);
          break;
        case "turn_start": {
          const replyToMessageId = MutableRef.get(latestTriggerMessageId);
          enqueueOutput(
            Effect.sync(() => {
              currentTurnReplyTo = replyToMessageId;
            }),
          );
          break;
        }
        case "compaction_start":
          enqueueOutput(onCompactionStart(event));
          break;
        case "compaction_end":
          enqueueOutput(onCompactionEnd(event));
          break;
        case "message_start":
          enqueueOutput(onMessageStart(event));
          break;
        case "message_end":
          enqueueOutput(onMessageEnd(event));
          break;
        case "message_update":
          enqueueOutput(onMessageUpdate(event));
          break;
        case "tool_execution_start":
        case "tool_execution_end":
          enqueueOutput(onToolExecution(event));
          break;
        case "auto_retry_start":
          enqueueOutput(onAutoRetryStart(event));
          break;
        case "auto_retry_end":
          enqueueOutput(onAutoRetryEnd(event));
          break;
      }
    };

    const reportUnexpectedError = (error: unknown): void => {
      enqueueOutput(
        typingIndicator.deactivate.pipe(Effect.andThen(sendRunError(formatUnexpectedError(error)))),
      );
    };

    yield* Effect.addFinalizer(() =>
      outputWorker.drain.pipe(
        Effect.timeout("3 seconds"),
        Effect.ignore({
          log: "Warn",
          message: `Timed out waiting for output queue to drain for channel ${input.channel.id}`,
        }),
      ),
    );

    return {
      handleSessionEvent,
      reportUnexpectedError,
      executeOrdered,
      pushActivationMessageId,
    };
  });
