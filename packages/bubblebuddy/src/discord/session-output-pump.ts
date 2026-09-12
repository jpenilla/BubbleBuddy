import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type GuildTextBasedChannel, type Message } from "discord.js";
import { Cause, Deferred, Effect, Scope } from "effect";

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
import { ToolOutput } from "./tool-output.ts";
import { ToolOutputPolicies } from "./tool-output-policies.ts";
import {
  sendChunkedMessage,
  sendMessage,
  sendOrEditStatusCard,
  tryDiscordJsPromise,
} from "../discord/utils.ts";
import { createPriorityDrainableWorker } from "../shared/priority-drainable-worker.ts";
import { splitThinkingStatus } from "../discord/response-formatting.ts";

export type ExecuteOrderedDiscordAction = <A, E>(
  operation: Effect.Effect<A, E>,
) => Effect.Effect<A, E>;

export interface DiscordOutputPump {
  readonly handleSessionEvent: (event: AgentSessionEvent) => void;
  readonly reportUnexpectedError: (error: unknown) => void;
  readonly executeOrdered: ExecuteOrderedDiscordAction;
}

interface CreateDiscordOutputPumpInput {
  readonly channel: GuildTextBasedChannel;
  readonly showThinking: Effect.Effect<boolean>;
}

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
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.logDebug("Discord output action interrupted", cause)
              : Effect.logError("Discord output action failed", cause),
          ),
          Effect.withSpan("DiscordOutputPump.process", {
            root: true,
            attributes: { channelId: input.channel.id },
          }),
          Effect.ignoreCause(),
        ),
    );
    const channel = input.channel;
    const runtimeContext = yield* Effect.context();
    const typingIndicator = yield* createTypingIndicator({ channel });

    let compactionStatusMessage: Message<true> | undefined;
    let retryStatusState: RetryStatusState | undefined;
    let pendingText = "";
    const toolOutputs = yield* ToolOutput.make(channel, ToolOutputPolicies.forTool);

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

    const withToolOutputBoundary = <A, E, R>(
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => toolOutputs.boundary.pipe(Effect.andThen(operation));

    const sendCompactionStatus = (status: CompactionStatus) =>
      Effect.gen(function* () {
        const embed = createCompactionStatusEmbed(status);
        const existing = compactionStatusMessage;
        if (existing === undefined) yield* toolOutputs.boundary;
        const sent = yield* tryDiscordJsPromise(() =>
          sendOrEditStatusCard(channel, compactionStatusMessage, embed),
        );
        compactionStatusMessage = status.phase === "start" ? sent : undefined;
      });

    const flushPendingText = Effect.gen(function* () {
      const text = pendingText;
      pendingText = "";
      if (text.trim().length > 0) {
        yield* sendChunkedMessage({ channel, content: text }).pipe(
          withToolOutputBoundary,
          Effect.tap(() => typingIndicator.messageSent),
        );
      }
    });

    const startRetryStatus = (status: Extract<RetryStatus, { phase: "retrying" }>) =>
      Effect.gen(function* () {
        const embed = createRetryStatusEmbed(status);
        const existing = retryStatusState?.message;
        if (existing === undefined) yield* toolOutputs.boundary;
        const sent = yield* tryDiscordJsPromise(() =>
          sendOrEditStatusCard(channel, existing, embed),
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
        ).pipe(withToolOutputBoundary);
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
        yield* tryDiscordJsPromise(() => channel.send({ embeds: [createRunAbortedEmbed()] })).pipe(
          withToolOutputBoundary,
        );
      });

    const sendModelRequestError = (errorMessage: string) =>
      tryDiscordJsPromise(() =>
        channel.send({ embeds: [createModelRequestErrorEmbed(errorMessage)] }),
      ).pipe(withToolOutputBoundary, Effect.asVoid);

    const sendResponseTruncated = tryDiscordJsPromise(() =>
      channel.send({ embeds: [createResponseTruncatedEmbed()] }),
    ).pipe(withToolOutputBoundary, Effect.asVoid);

    const sendRunError = (errorMessage: string) =>
      tryDiscordJsPromise(() => channel.send({ embeds: [createRunErrorEmbed(errorMessage)] })).pipe(
        withToolOutputBoundary,
        Effect.asVoid,
      );

    const sendThinking = (text: string) =>
      Effect.forEach(splitThinkingStatus(text), (chunk) =>
        sendMessage(channel, { content: chunk }),
      ).pipe(Effect.asVoid, withToolOutputBoundary);

    const onAgentSettled = Effect.gen(function* () {
      retryStatusState = undefined;
      yield* toolOutputs.reset;
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
          yield* (
            event.aborted
              ? Effect.logDebug("Compaction interrupted")
              : event.willRetry
                ? Effect.logWarning("Compaction failed; retrying")
                : Effect.logError("Compaction failed")
          ).pipe(
            Effect.annotateLogs({
              reason: event.reason,
              willRetry: event.willRetry,
              errorMessage: event.errorMessage,
            }),
          );
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
      Effect.gen(function* () {
        if (event.message.role !== "assistant") return;
        pendingText = event.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (event.message.stopReason === "pending") {
          yield* typingIndicator.activate;
        }
      });

    const onMessageEnd = (event: SessionEvent<"message_end">) =>
      Effect.gen(function* () {
        if (event.message.role !== "assistant") {
          return;
        }

        yield* flushPendingText;
        yield* typingIndicator.deactivate;
        const msg = event.message;
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
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent.type === "text_start") {
          pendingText = "";
        } else if (assistantEvent.type === "text_delta") {
          pendingText += assistantEvent.delta;
        } else if (assistantEvent.type === "text_end") {
          pendingText = assistantEvent.content;
          yield* flushPendingText;
        } else if (assistantEvent.type === "thinking_end") {
          const showThinking = yield* input.showThinking;
          const thinking = assistantEvent.content.trim();
          if (showThinking && thinking.length > 0) {
            yield* sendThinking(thinking).pipe(Effect.tap(() => typingIndicator.messageSent));
          }
        }
      });

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

    const handleSessionEvent = (event: AgentSessionEvent): void => {
      switch (event.type) {
        case "agent_settled":
          enqueueOutput(onAgentSettled);
          break;
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
          enqueueOutput(toolOutputs.start(event));
          break;
        case "tool_execution_end":
          enqueueOutput(toolOutputs.complete(event));
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
          message: "Timed out waiting for Discord output queue to drain",
        }),
      ),
    );

    return {
      handleSessionEvent,
      reportUnexpectedError,
      executeOrdered,
    };
  }).pipe(Effect.annotateLogs({ channelId: input.channel.id }));
