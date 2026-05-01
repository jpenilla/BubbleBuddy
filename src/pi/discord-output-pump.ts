import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { Cause, Effect, Option, Queue } from "effect";

import { SHOW_THINKING_DEFAULT, type ChannelSettings } from "../channel-repository.ts";
import type { CompactionStatusEmbed } from "../discord/compaction-status-embed.ts";
import type { ToolStatusEmbed } from "../discord/tool-status-embed.ts";
import { extractAssistantText } from "../domain/text.ts";

type DiscordAction = () => Promise<void>;
export type RunDiscordAction = <T>(operation: () => Promise<T>) => Promise<T>;

export interface SessionSink {
  readonly onCompactionStatus: (status: CompactionStatusEmbed) => Promise<void>;
  readonly onError: (text: string) => Promise<void>;
  readonly onFinal: (text: string, replyToMessageId: string) => Promise<void>;
  readonly onIntermediate: (text: string, replyToMessageId: string) => Promise<void>;
  readonly onRunEnd: () => Promise<void>;
  readonly onRunStart: () => Promise<void>;
  readonly onStatus: (status: ToolStatusEmbed) => Promise<void>;
  readonly onThinking: (text: string) => Promise<void>;
}

interface DiscordOutputPumpOptions {
  readonly getChannelSettings: () => Readonly<ChannelSettings>;
  readonly initialReplyToMessageId: string;
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

export class DiscordOutputPump {
  readonly #mutationQueue: Queue.Queue<DiscordAction>;
  readonly #sink: SessionSink;
  readonly #statusQueue: Queue.Queue<DiscordAction>;
  readonly #getChannelSettings: () => Readonly<ChannelSettings>;
  #isShuttingDown = false;
  #latestTriggerMessageId: string;
  #currentTurnReplyTo: string = "";

  private constructor(
    options: DiscordOutputPumpOptions,
    statusQueue: Queue.Queue<DiscordAction>,
    mutationQueue: Queue.Queue<DiscordAction>,
  ) {
    this.#getChannelSettings = options.getChannelSettings;
    this.#mutationQueue = mutationQueue;
    this.#latestTriggerMessageId = options.initialReplyToMessageId;
    this.#sink = options.sink;
    this.#statusQueue = statusQueue;
  }

  static make(options: DiscordOutputPumpOptions): Effect.Effect<DiscordOutputPump> {
    return Effect.gen(function* () {
      const statusQueue = yield* Queue.unbounded<DiscordAction>();
      const mutationQueue = yield* Queue.unbounded<DiscordAction>();
      return new DiscordOutputPump(options, statusQueue, mutationQueue);
    });
  }

  drain(): Effect.Effect<void> {
    return Effect.promise(() =>
      Promise.all([
        new Promise<void>((resolve) => {
          if (!this.#offerDiscordAction(this.#statusQueue, async () => resolve())) {
            resolve();
          }
        }),
        new Promise<void>((resolve) => {
          if (!this.#offerDiscordAction(this.#mutationQueue, async () => resolve())) {
            resolve();
          }
        }),
      ]).then(() => undefined),
    );
  }

  enqueueRunEnd(): void {
    this.#enqueueStatusAction(() => this.#sink.onRunEnd());
  }

  enqueueUnexpectedError(error: unknown): void {
    if (!this.#isShuttingDown) {
      this.#enqueueStatusAction(() => this.#sink.onError(this.#formatUnexpectedError(error)));
    }
  }

  handleSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.#enqueueStatusAction(() => this.#sink.onRunStart());
        break;
      case "agent_end":
        this.#enqueueStatusAction(() => this.#sink.onRunEnd());
        break;
      case "turn_start":
        this.#currentTurnReplyTo = this.#latestTriggerMessageId;
        break;
      case "compaction_start":
        this.#enqueueStatusAction(() =>
          this.#sink.onCompactionStatus({
            phase: "start",
            reason: event.reason,
          }),
        );
        break;
      case "compaction_end":
        if (event.errorMessage !== undefined) {
          void Effect.runFork(Effect.logWarning(event.errorMessage));
        }
        this.#enqueueStatusAction(() =>
          this.#sink.onCompactionStatus({
            phase: event.aborted ? "aborted" : event.result === undefined ? "error" : "success",
            reason: event.reason,
            tokensBefore: event.result?.tokensBefore,
          }),
        );
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          const msg = event.message;
          if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            if (!this.#isShuttingDown) {
              this.#enqueueStatusAction(() =>
                this.#sink.onError(msg.errorMessage ?? "The model request failed."),
              );
            }
            break;
          }
          const text = extractAssistantText(msg);
          if (text.trim().length === 0) {
            break;
          }
          if (msg.stopReason === "toolUse") {
            // More turns are guaranteed — send now as non-pinging reply
            this.#enqueueStatusAction(() =>
              this.#sink.onIntermediate(text, this.#currentTurnReplyTo),
            );
          } else {
            // stop or length — almost certainly the final answer — send as pinging reply
            this.#enqueueStatusAction(() => this.#sink.onFinal(text, this.#currentTurnReplyTo));
          }
        }
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "thinking_end") {
          if (this.#getChannelSettings().showThinking ?? SHOW_THINKING_DEFAULT) {
            const thinking = event.assistantMessageEvent.content.trim();
            if (thinking.length > 0) {
              this.#enqueueStatusAction(() => this.#sink.onThinking(thinking));
            }
          }
        }
        break;
      case "tool_execution_end":
      case "tool_execution_start":
        if (!SUPPRESSED_TOOL_STATUS.has(event.toolName)) {
          this.#enqueueStatusAction(() =>
            this.#sink.onStatus({
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
    }
  }

  run(): Effect.Effect<void> {
    const statusQueue = this.#statusQueue;
    const mutationQueue = this.#mutationQueue;

    const loop = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        let action = yield* Queue.poll(statusQueue).pipe(Effect.map(Option.getOrNull));
        if (action === null) {
          action = yield* Queue.poll(mutationQueue).pipe(Effect.map(Option.getOrNull));
        }
        if (action === null) {
          action = yield* Effect.raceFirst(Queue.take(statusQueue), Queue.take(mutationQueue)).pipe(
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
  }

  readonly runDiscordAction: RunDiscordAction = <T>(operation: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const enqueued = this.#offerDiscordAction(this.#mutationQueue, async () => {
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

  setReplyToMessageId(replyToMessageId: string): void {
    this.#latestTriggerMessageId = replyToMessageId;
  }

  setShuttingDown(isShuttingDown: boolean): void {
    this.#isShuttingDown = isShuttingDown;
  }

  shutdownQueues(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* Queue.shutdown(this.#statusQueue);
      yield* Queue.shutdown(this.#mutationQueue);
    });
  }

  #enqueueStatusAction(action: DiscordAction): void {
    this.#offerDiscordAction(this.#statusQueue, action);
  }

  #formatUnexpectedError(error: unknown): string {
    return error instanceof Error && error.message.length > 0
      ? `The model request failed: ${error.message}`
      : "The model request failed.";
  }

  #offerDiscordAction(queue: Queue.Queue<DiscordAction>, action: DiscordAction): boolean {
    try {
      return Effect.runSync(Queue.offer(queue, action));
    } catch {
      return false;
    }
  }
}
