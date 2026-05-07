import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { Cause, Effect, Option, Queue } from "effect";

import { SHOW_THINKING_DEFAULT, type ChannelSettings } from "../channel-repository.ts";
import type { CompactionStatusEmbed } from "../discord/compaction-status-embed.ts";
import type { RetryStatusEmbed } from "../discord/run-status-embed.ts";
import type { ToolStatusEmbed } from "../discord/tool-status-embed.ts";
import { extractAssistantText } from "../domain/text.ts";

type DiscordAction = () => Promise<void>;
export type RunDiscordAction = <T>(operation: () => Promise<T>) => Promise<T>;

export interface SessionSink {
  readonly onCompactionStatus: (status: CompactionStatusEmbed) => Promise<void>;
  readonly onFinal: (text: string, replyToMessageId: string) => Promise<void>;
  readonly onIntermediate: (text: string, replyToMessageId: string) => Promise<void>;
  readonly onRetryStatus: (status: RetryStatusEmbed) => Promise<void>;
  readonly onRunAborted: () => Promise<void>;
  readonly onRunEnd: () => Promise<void>;
  readonly onRunError: (errorMessage: string) => Promise<void>;
  readonly onRunStart: () => Promise<void>;
  readonly onStatus: (status: ToolStatusEmbed) => Promise<void>;
  readonly onThinking: (text: string) => Promise<void>;
}

export interface DiscordOutputPump {
  readonly drain: () => Effect.Effect<void>;
  readonly enqueueRunEnd: () => void;
  readonly enqueueUnexpectedError: (error: unknown) => void;
  readonly handleSessionEvent: (event: AgentSessionEvent) => void;
  readonly run: () => Effect.Effect<void>;
  readonly runDiscordAction: RunDiscordAction;
  readonly setReplyToMessageId: (replyToMessageId: string) => void;
  readonly shutdownQueues: () => Effect.Effect<void>;
}

interface DiscordOutputPumpOptions {
  readonly getChannelSettings: () => Readonly<ChannelSettings>;
  readonly sink: SessionSink;
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

const offerDiscordAction = (queue: Queue.Queue<DiscordAction>, action: DiscordAction): boolean => {
  try {
    return Effect.runSync(Queue.offer(queue, action));
  } catch {
    return false;
  }
};

export const makeDiscordOutputPump = (
  options: DiscordOutputPumpOptions,
): Effect.Effect<DiscordOutputPump> =>
  Effect.gen(function* () {
    const statusQueue = yield* Queue.unbounded<DiscordAction>();
    const mutationQueue = yield* Queue.unbounded<DiscordAction>();
    const getChannelSettings = options.getChannelSettings;
    const sink = options.sink;
    const ctx = yield* Effect.context();

    let latestTriggerMessageId = "";
    let currentTurnReplyTo = "";

    const enqueueStatusAction = (action: DiscordAction): void => {
      offerDiscordAction(statusQueue, action);
    };

    const setReplyToMessageId = (replyToMessageId: string): void => {
      latestTriggerMessageId = replyToMessageId;
    };

    const handleSessionEvent = (event: AgentSessionEvent): void => {
      switch (event.type) {
        case "agent_start":
          enqueueStatusAction(() => sink.onRunStart());
          break;
        case "agent_end":
          enqueueStatusAction(() => sink.onRunEnd());
          break;
        case "turn_start":
          currentTurnReplyTo = latestTriggerMessageId;
          break;
        case "compaction_start":
          enqueueStatusAction(() =>
            sink.onCompactionStatus({
              phase: "start",
              reason: event.reason,
            }),
          );
          break;
        case "compaction_end":
          if (event.errorMessage !== undefined) {
            void Effect.runForkWith(ctx)(Effect.logWarning(event.errorMessage));
          }
          enqueueStatusAction(() =>
            sink.onCompactionStatus({
              phase: event.aborted ? "aborted" : event.result === undefined ? "error" : "success",
              reason: event.reason,
              tokensBefore: event.result?.tokensBefore,
            }),
          );
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            const msg = event.message;
            if (msg.stopReason === "error") {
              enqueueStatusAction(() =>
                sink.onRunError(msg.errorMessage ?? "The model request failed."),
              );
              break;
            }
            if (msg.stopReason === "aborted") {
              enqueueStatusAction(() => sink.onRunAborted());
              break;
            }
            const text = extractAssistantText(msg);
            if (text.trim().length === 0) {
              break;
            }
            if (msg.stopReason === "toolUse") {
              // More turns are guaranteed — send now as non-pinging reply
              enqueueStatusAction(() => sink.onIntermediate(text, currentTurnReplyTo));
            } else {
              // stop or length — almost certainly the final answer — send as pinging reply
              enqueueStatusAction(() => sink.onFinal(text, currentTurnReplyTo));
            }
          }
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "thinking_end") {
            if (getChannelSettings().showThinking ?? SHOW_THINKING_DEFAULT) {
              const thinking = event.assistantMessageEvent.content.trim();
              if (thinking.length > 0) {
                enqueueStatusAction(() => sink.onThinking(thinking));
              }
            }
          }
          break;
        case "tool_execution_end":
        case "tool_execution_start":
          if (!SUPPRESSED_TOOL_STATUS.has(event.toolName)) {
            enqueueStatusAction(() =>
              sink.onStatus({
                phase:
                  event.type === "tool_execution_start"
                    ? "start"
                    : event.isError
                      ? "error"
                      : "success",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              }),
            );
          }
          break;
        case "auto_retry_start":
          enqueueStatusAction(() =>
            sink.onRetryStatus({
              phase: "retrying",
              attempt: event.attempt,
            }),
          );
          break;
        case "auto_retry_end":
          enqueueStatusAction(() =>
            sink.onRetryStatus(
              event.success
                ? { phase: "success" }
                : { phase: "failure", finalError: event.finalError },
            ),
          );
          break;
      }
    };

    const enqueueRunEnd = (): void => {
      enqueueStatusAction(() => sink.onRunEnd());
    };

    const enqueueUnexpectedError = (error: unknown): void => {
      enqueueStatusAction(() => sink.onRunError(formatUnexpectedError(error)));
    };

    const drain = (): Effect.Effect<void> =>
      Effect.promise(() =>
        Promise.all([
          new Promise<void>((resolve) => {
            if (!offerDiscordAction(statusQueue, async () => resolve())) {
              resolve();
            }
          }),
          new Promise<void>((resolve) => {
            if (!offerDiscordAction(mutationQueue, async () => resolve())) {
              resolve();
            }
          }),
        ]).then(() => undefined),
      );

    const run = (): Effect.Effect<void> => {
      const loop = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          let action = yield* Queue.poll(statusQueue).pipe(Effect.map(Option.getOrNull));
          if (action === null) {
            action = yield* Queue.poll(mutationQueue).pipe(Effect.map(Option.getOrNull));
          }
          if (action === null) {
            action = yield* Effect.raceFirst(
              Queue.take(statusQueue),
              Queue.take(mutationQueue),
            ).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) ? Effect.succeed(null) : Effect.failCause(cause),
              ),
            );
            if (action === null) {
              return;
            }
          }

          yield* Effect.tryPromise(() => action()).pipe(
            Effect.ignore({ log: "Warn", message: "Discord output action failed" }),
          );

          yield* Effect.suspend(loop);
        });

      return loop();
    };

    const runDiscordAction: RunDiscordAction = <T>(operation: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const enqueued = offerDiscordAction(mutationQueue, async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        });

        if (!enqueued) {
          reject(new Error("Discord action queue is unavailable."));
        }
      });

    const shutdownQueues = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Queue.shutdown(statusQueue);
        yield* Queue.shutdown(mutationQueue);
      });

    return {
      drain,
      enqueueRunEnd,
      enqueueUnexpectedError,
      handleSessionEvent,
      run,
      runDiscordAction,
      setReplyToMessageId,
      shutdownQueues,
    };
  });
