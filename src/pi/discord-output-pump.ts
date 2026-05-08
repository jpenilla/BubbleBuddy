import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { Deferred, Effect, HashMap, MutableRef, Option, Ref, Scope } from "effect";

import { makeTypingIndicator } from "../discord/typing-indicator.ts";

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

export type AwaitToolDiscordAction = <T>(
  operation: Effect.Effect<T, unknown>,
) => Effect.Effect<T, unknown>;

export interface DiscordOutputPump {
  readonly handleSessionEvent: (event: AgentSessionEvent) => void;
  readonly reportUnexpectedError: (error: unknown) => void;
  readonly awaitToolDiscordAction: AwaitToolDiscordAction;
  readonly pushActivationMessageId: (messageId: string) => void;
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

type SessionEvent<Type extends AgentSessionEvent["type"]> = Extract<
  AgentSessionEvent,
  { type: Type }
>;

export const makeDiscordOutputPump = (
  options: DiscordOutputPumpOptions,
): Effect.Effect<DiscordOutputPump, never, Scope.Scope> =>
  Effect.gen(function* () {
    const worker = yield* makePriorityDrainableWorker((job: Effect.Effect<void, unknown>) =>
      job.pipe(
        Effect.ignore({
          log: "Warn",
          message: `Discord output action failed for channel ${options.channel.id}`,
        }),
      ),
    );
    const channel = options.channel;
    const config = options.config;
    const getShowThinking = options.getShowThinking;
    const ctx = yield* Effect.context();
    const typingIndicator = yield* makeTypingIndicator({
      channel,
      intervalMs: config.typingIndicatorIntervalMs,
    });

    const latestTriggerMessageId = MutableRef.make("");
    const currentTurnReplyTo = yield* Ref.make("");
    const compactionStatusMessage = yield* Ref.make<Message<true> | undefined>(undefined);
    const runRetryMessage = yield* Ref.make<Message<true> | undefined>(undefined);
    const toolStatusMessages = yield* Ref.make(HashMap.empty<string, Message<true>>());

    const resetRunState = Effect.gen(function* () {
      yield* Ref.set(currentTurnReplyTo, "");
      yield* Ref.set(runRetryMessage, undefined);
      yield* Ref.set(toolStatusMessages, HashMap.empty<string, Message<true>>());
    });

    const enqueueRunDiscordAction = (job: Effect.Effect<void, unknown>): void => {
      void Effect.runForkWith(ctx)(worker.enqueueHigh(job).pipe(Effect.ignore));
    };

    const awaitToolDiscordAction: AwaitToolDiscordAction = <T>(
      operation: Effect.Effect<T, unknown>,
    ) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<T, unknown>();
        yield* worker.enqueueLow(Deferred.completeWith(deferred, operation));
        return yield* Deferred.await(deferred);
      });

    const sendCompactionStatus = (status: CompactionStatusEmbed): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const embed = createCompactionStatusEmbed(status);
        const existing = yield* Ref.get(compactionStatusMessage);
        const sent = yield* Effect.tryPromise(() => sendOrEditStatusCard(channel, existing, embed));
        yield* Ref.set(compactionStatusMessage, status.phase === "start" ? sent : undefined);
      });

    const sendFinal = (text: string, replyToMessageId: string): Effect.Effect<void, unknown> =>
      Effect.tryPromise(() =>
        sendChunkedMessage({
          channel,
          content: text,
          reply: {
            messageReference: replyToMessageId,
            failIfNotExists: false,
          },
        }),
      );

    const sendIntermediate = (
      text: string,
      replyToMessageId: string,
    ): Effect.Effect<void, unknown> =>
      Effect.tryPromise(() =>
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

    const sendRetryStatus = (status: RetryStatusEmbed): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const embed = createRetryStatusEmbed(status);
        const existing = yield* Ref.get(runRetryMessage);
        const sent = yield* Effect.tryPromise(() => sendOrEditStatusCard(channel, existing, embed));
        yield* Ref.set(
          runRetryMessage,
          status.phase === "success" || status.phase === "failure" || status.phase === "aborted"
            ? undefined
            : sent,
        );
      });

    const sendRunAborted = (): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(runRetryMessage);
        if (existing !== undefined) {
          const embed = createRetryStatusEmbed({ phase: "aborted" });
          yield* Effect.tryPromise(() => sendOrEditStatusCard(channel, existing, embed));
          yield* Ref.set(runRetryMessage, undefined);
          return;
        }
        yield* Effect.tryPromise(() => channel.send({ embeds: [createRunAbortedEmbed()] }));
      });

    const sendRunError = (errorMessage: string): Effect.Effect<void, unknown> =>
      Effect.tryPromise(() => channel.send({ embeds: [createRunErrorEmbed({ errorMessage })] }));

    const sendToolStatus = (status: ToolStatusEmbed): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const embed = createToolStatusEmbed(status);
        const messages = yield* Ref.get(toolStatusMessages);
        const existing = HashMap.get(messages, status.toolCallId).pipe(Option.getOrUndefined);
        const sent = yield* Effect.tryPromise(() => sendOrEditStatusCard(channel, existing, embed));
        yield* Ref.update(toolStatusMessages, (current) =>
          status.phase === "start"
            ? HashMap.set(current, status.toolCallId, sent)
            : HashMap.remove(current, status.toolCallId),
        );
      });

    const sendThinking = (text: string): Effect.Effect<void, unknown> =>
      Effect.forEach(splitThinkingStatus(text), (chunk) =>
        Effect.tryPromise(() => channel.send(chunk)),
      ).pipe(Effect.asVoid);

    const onAgentStart = (_event: SessionEvent<"agent_start">): Effect.Effect<void, unknown> =>
      resetRunState.pipe(Effect.andThen(typingIndicator.start));

    const onAgentEnd = (_event: SessionEvent<"agent_end">): Effect.Effect<void, unknown> =>
      resetRunState.pipe(Effect.andThen(typingIndicator.awaitStop));

    const onCompactionStart = (
      event: SessionEvent<"compaction_start">,
    ): Effect.Effect<void, unknown> =>
      sendCompactionStatus({
        phase: "start",
        reason: event.reason,
      }).pipe(Effect.tap(() => typingIndicator.refresh));

    const onCompactionEnd = (event: SessionEvent<"compaction_end">): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        if (event.errorMessage !== undefined) {
          yield* Effect.logWarning(event.errorMessage);
        }
        yield* sendCompactionStatus({
          phase: event.aborted ? "aborted" : event.result === undefined ? "error" : "success",
          reason: event.reason,
          tokensBefore: event.result?.tokensBefore,
        }).pipe(Effect.tap(() => typingIndicator.refresh));
      });

    const onMessageEnd = (event: SessionEvent<"message_end">): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        if (event.message.role !== "assistant") {
          return;
        }

        const msg = event.message;
        if (msg.stopReason === "error") {
          yield* typingIndicator.awaitStop;
          yield* sendRunError(msg.errorMessage ?? "The model request failed.");
          return;
        }
        if (msg.stopReason === "aborted") {
          yield* typingIndicator.awaitStop;
          yield* sendRunAborted();
          return;
        }

        const text = extractAssistantText(msg);
        if (text.trim().length === 0) {
          return;
        }

        const replyToMessageId = yield* Ref.get(currentTurnReplyTo);
        if (msg.stopReason === "toolUse") {
          yield* sendIntermediate(text, replyToMessageId).pipe(
            Effect.tap(() => typingIndicator.refresh),
          );
        } else {
          yield* typingIndicator.awaitStop;
          yield* sendFinal(text, replyToMessageId);
        }
      });

    const onMessageUpdate = (event: SessionEvent<"message_update">): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        if (event.assistantMessageEvent.type !== "thinking_end" || !getShowThinking()) {
          return;
        }
        const thinking = event.assistantMessageEvent.content.trim();
        if (thinking.length > 0) {
          yield* sendThinking(thinking).pipe(Effect.tap(() => typingIndicator.refresh));
        }
      });

    const onToolExecution = (
      event: SessionEvent<"tool_execution_start"> | SessionEvent<"tool_execution_end">,
    ): Effect.Effect<void, unknown> => {
      if (SUPPRESSED_TOOL_STATUS.has(event.toolName)) {
        return Effect.void;
      }
      return sendToolStatus({
        phase:
          event.type === "tool_execution_start" ? "start" : event.isError ? "error" : "success",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      }).pipe(Effect.tap(() => typingIndicator.refresh));
    };

    const onAutoRetryStart = (
      event: SessionEvent<"auto_retry_start">,
    ): Effect.Effect<void, unknown> =>
      sendRetryStatus({
        phase: "retrying",
        attempt: event.attempt,
      }).pipe(Effect.tap(() => typingIndicator.refresh));

    const onAutoRetryEnd = (event: SessionEvent<"auto_retry_end">): Effect.Effect<void, unknown> =>
      sendRetryStatus(
        event.success ? { phase: "success" } : { phase: "failure", finalError: event.finalError },
      ).pipe(Effect.tap(() => typingIndicator.refresh));

    const pushActivationMessageId = (messageId: string): void => {
      MutableRef.set(latestTriggerMessageId, messageId);
    };

    const handleSessionEvent = (event: AgentSessionEvent): void => {
      switch (event.type) {
        case "agent_start":
          enqueueRunDiscordAction(onAgentStart(event));
          break;
        case "agent_end":
          enqueueRunDiscordAction(onAgentEnd(event));
          break;
        case "turn_start": {
          const replyToMessageId = MutableRef.get(latestTriggerMessageId);
          enqueueRunDiscordAction(Ref.set(currentTurnReplyTo, replyToMessageId));
          break;
        }
        case "compaction_start":
          enqueueRunDiscordAction(onCompactionStart(event));
          break;
        case "compaction_end":
          enqueueRunDiscordAction(onCompactionEnd(event));
          break;
        case "message_end":
          enqueueRunDiscordAction(onMessageEnd(event));
          break;
        case "message_update":
          enqueueRunDiscordAction(onMessageUpdate(event));
          break;
        case "tool_execution_start":
        case "tool_execution_end":
          enqueueRunDiscordAction(onToolExecution(event));
          break;
        case "auto_retry_start":
          enqueueRunDiscordAction(onAutoRetryStart(event));
          break;
        case "auto_retry_end":
          enqueueRunDiscordAction(onAutoRetryEnd(event));
          break;
      }
    };

    const reportUnexpectedError = (error: unknown): void => {
      enqueueRunDiscordAction(
        sendRunError(formatUnexpectedError(error)).pipe(Effect.tap(() => typingIndicator.refresh)),
      );
    };

    yield* Effect.addFinalizer(() =>
      worker.drain.pipe(
        Effect.timeout("3 seconds"),
        Effect.ignore({
          log: "Warn",
          message: `Timed out waiting for output queue to drain for channel ${options.channel.id}`,
        }),
      ),
    );

    return {
      handleSessionEvent,
      reportUnexpectedError,
      awaitToolDiscordAction,
      pushActivationMessageId,
    };
  });
