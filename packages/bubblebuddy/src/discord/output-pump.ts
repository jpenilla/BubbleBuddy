import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type GuildTextBasedChannel, type Message } from "discord.js";
import { Cause, Context, Deferred, Effect, Match, Scope, Tracer } from "effect";

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
import { type SessionEvent } from "../pi/session-events.ts";

export type ExecuteOrderedDiscordAction = <A, E>(
  operation: Effect.Effect<A, E>,
) => Effect.Effect<A, E>;

export interface DiscordOutputPump {
  readonly handleSessionEvent: (event: AgentSessionEvent) => void;
  readonly reportUnexpectedError: (error: unknown) => Effect.Effect<void>;
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

interface WorkItem {
  readonly operation: Effect.Effect<void, unknown>;
  readonly producerSpan: Tracer.Span;
}

const createWorkItem = Effect.fnUntraced(function* (operation: Effect.Effect<void, unknown>) {
  const producerSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
  return { operation, producerSpan } satisfies WorkItem;
});

interface RetryStatusState {
  readonly message: Message<true>;
  readonly attempt: number;
}

export const createDiscordOutputPump = (
  input: CreateDiscordOutputPumpInput,
): Effect.Effect<DiscordOutputPump, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outputWorker = yield* createPriorityDrainableWorker((item: WorkItem) =>
      item.operation.pipe(
        Effect.onError((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.logDebug("Discord output action interrupted", cause)
            : Effect.logError("Discord output action failed", cause),
        ),
        Effect.withSpan("DiscordOutputPump.process", {
          root: true,
          attributes: { channelId: input.channel.id },
          links: [{ span: item.producerSpan, attributes: { relationship: "enqueued-by" } }],
        }),
        Effect.ignoreCause(),
      ),
    );
    const channel = input.channel;
    const typingIndicator = yield* createTypingIndicator({ channel });

    let compactionStatusMessage: Message<true> | undefined;
    let retryStatusState: RetryStatusState | undefined;
    let pendingText = "";
    const toolOutputs = yield* ToolOutput.make(channel, ToolOutputPolicies.forTool);

    const enqueueHigh = (operation: Effect.Effect<void, unknown>): Effect.Effect<void> =>
      createWorkItem(operation).pipe(
        Effect.flatMap(outputWorker.enqueueHigh),
        Effect.withSpan("DiscordOutputPump.enqueueHigh", { root: true }),
      );

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

      return yield* outputWorker.enqueueLow(yield* createWorkItem(queuedOperation)).pipe(
        Effect.andThen(Deferred.await(result)),
        Effect.onInterrupt(() => Deferred.succeed(canceled, undefined)),
      );
    });

    const withToolOutputBoundary = <A, E, R>(
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => toolOutputs.boundary.pipe(Effect.andThen(operation));

    const sendCompactionStatus = Effect.fn("DiscordOutputPump.sendCompactionStatus")(function* (
      status: CompactionStatus,
    ) {
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
        yield* sendChunkedMessage({ channel, content: text }).pipe(withToolOutputBoundary);
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

    const onAgentSettled = Effect.fn("DiscordOutputPump.onAgentSettled")(function* () {
      retryStatusState = undefined;
      yield* toolOutputs.reset;
      yield* typingIndicator.deactivate;
    });

    const onCompactionStart = (event: SessionEvent<"compaction_start">) =>
      sendCompactionStatus({
        phase: "start",
        reason: event.reason,
      });

    const onCompactionEnd = Effect.fn("DiscordOutputPump.onCompactionEnd")(function* (
      event: SessionEvent<"compaction_end">,
    ) {
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

    const onMessageStart = (event: SessionEvent<"message_start">) => {
      const msg = event.message;
      if (msg.role !== "assistant") return Effect.void;
      return enqueueHigh(
        Effect.sync(() => {
          pendingText = msg.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
        }).pipe(Effect.withSpan("DiscordOutputPump.onMessageStart")),
      );
    };

    const onMessageEnd = (event: SessionEvent<"message_end">) => {
      const msg = event.message;
      if (msg.role !== "assistant") return Effect.void;
      return enqueueHigh(
        Effect.gen(function* () {
          yield* typingIndicator.deactivate;
          yield* flushPendingText;
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
        }).pipe(Effect.withSpan("DiscordOutputPump.onMessageEnd")),
      );
    };

    const onMessageUpdate = (event: SessionEvent<"message_update">) => {
      const assistantEvent = event.assistantMessageEvent;
      const enqueueUpdate = (operation: Effect.Effect<void, unknown>) =>
        enqueueHigh(operation.pipe(Effect.withSpan("DiscordOutputPump.onMessageUpdate")));

      switch (assistantEvent.type) {
        case "text_start":
          return enqueueUpdate(
            Effect.sync(() => {
              pendingText = "";
            }),
          );
        case "text_delta":
          return enqueueUpdate(
            Effect.gen(function* () {
              pendingText += assistantEvent.delta;
              if (assistantEvent.delta.length > 0) {
                yield* typingIndicator.activate;
              }
            }),
          );
        case "text_end":
          return enqueueUpdate(
            Effect.gen(function* () {
              pendingText = assistantEvent.content;
              yield* typingIndicator.deactivate;
              yield* flushPendingText;
            }),
          );
        case "thinking_delta":
          return enqueueUpdate(typingIndicator.deactivate);
        case "thinking_end":
          return enqueueUpdate(
            Effect.gen(function* () {
              const showThinking = yield* input.showThinking;
              const thinking = assistantEvent.content.trim();
              if (showThinking && thinking.length > 0) {
                yield* typingIndicator.deactivate;
                yield* sendThinking(thinking);
              }
            }),
          );
        default:
          return Effect.void;
      }
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

    const sessionEventHandler = Match.type<AgentSessionEvent>().pipe(
      Match.discriminators("type")({
        agent_settled: () => enqueueHigh(onAgentSettled()),
        compaction_start: (e) => enqueueHigh(onCompactionStart(e)),
        compaction_end: (e) => enqueueHigh(onCompactionEnd(e)),
        message_start: onMessageStart,
        message_end: onMessageEnd,
        message_update: onMessageUpdate,
        tool_execution_start: (e) => enqueueHigh(toolOutputs.start(e)),
        tool_execution_end: (e) => enqueueHigh(toolOutputs.complete(e)),
        auto_retry_start: (e) => enqueueHigh(onAutoRetryStart(e)),
        auto_retry_end: (e) => enqueueHigh(onAutoRetryEnd(e)),
      }),
      Match.orElse(() => Effect.void),
    );

    const runSync = Effect.runSyncWith(
      Context.omit(Tracer.ParentSpan)(yield* Effect.context<never>()),
    );
    const handleSessionEvent = (event: AgentSessionEvent) =>
      runSync(
        Effect.suspend(() => sessionEventHandler(event)).pipe(
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.logDebug("Session event handling interrupted", cause)
              : Effect.logError("Session event handling failed", cause),
          ),
          Effect.annotateLogs({ eventType: event.type }),
          Effect.ignoreCause(),
        ),
      );

    const reportUnexpectedError = (error: unknown): Effect.Effect<void> =>
      enqueueHigh(
        typingIndicator.deactivate.pipe(Effect.andThen(sendRunError(formatUnexpectedError(error)))),
      );

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
