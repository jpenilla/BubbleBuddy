import { describe, expect, test } from "bun:test";
import { Effect, Queue } from "effect";

import { PiChannelSession, type SessionSink } from "../src/pi/channel-session.ts";

type DiscordAction = () => Promise<void>;
type SessionEvent =
  | {
      readonly type: "agent_end";
      readonly messages: readonly [{ readonly role: "assistant"; readonly stopReason: "aborted" }];
    }
  | {
      readonly type: "tool_execution_end" | "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | { readonly type: string };

describe("channel session Discord output ordering", () => {
  test("processes tool completion statuses between queued Discord mutations", async () => {
    const observed: string[] = [];
    const sink: SessionSink = {
      onError: async () => {
        throw new Error("unexpected onError");
      },
      onFinal: async () => {
        throw new Error("unexpected onFinal");
      },
      onRunEnd: async () => {
        throw new Error("unexpected onRunEnd");
      },
      onRunStart: async () => {
        throw new Error("unexpected onRunStart");
      },
      onStatus: async (status) => {
        observed.push(`${status.phase}:${status.toolCallId}`);
      },
      onThinking: async () => {
        throw new Error("unexpected onThinking");
      },
    };

    let subscriber: ((event: SessionEvent) => void) | undefined;
    const fakeSession = {
      agent: {
        reset: () => undefined,
        waitForIdle: async () => undefined,
      },
      dispose: () => undefined,
      isStreaming: false,
      subscribe: (callback: (event: SessionEvent) => void) => {
        subscriber = callback;
        return () => {
          subscriber = undefined;
        };
      },
    };

    const statusQueue = Effect.runSync(Queue.unbounded<DiscordAction>());
    const mutationQueue = Effect.runSync(Queue.unbounded<DiscordAction>());
    const session = new (PiChannelSession as unknown as new (
      agentSession: typeof fakeSession,
      sink: SessionSink,
      statusQueue: Queue.Queue<DiscordAction>,
      mutationQueue: Queue.Queue<DiscordAction>,
      initialReplyToMessageId: string,
    ) => PiChannelSession)(fakeSession, sink, statusQueue, mutationQueue, "message-1");

    const emit = (event: SessionEvent): void => {
      subscriber?.(event);
    };

    const runDiscordAction = <T>(operation: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const enqueued = Effect.runSync(
          Queue.offer(mutationQueue, async () => {
            try {
              resolve(await operation());
            } catch (error) {
              reject(error);
            }
          }),
        );

        if (!enqueued) {
          reject(new Error("Discord action queue is unavailable."));
        }
      });

    try {
      const toolIds = ["tool-1", "tool-2", "tool-3"];
      for (const toolCallId of toolIds) {
        emit({
          type: "tool_execution_start",
          toolCallId,
          toolName: "discord_send_sticker",
        });
      }

      await Promise.all(
        toolIds.map((toolCallId) =>
          (async () => {
            await runDiscordAction(async () => {
              observed.push(`mutate:${toolCallId}`);
            });
            emit({
              type: "tool_execution_end",
              toolCallId,
              toolName: "discord_send_sticker",
            });
          })(),
        ),
      );

      await new Promise<void>((resolve, reject) => {
        const enqueued = Effect.runSync(
          Queue.offer(statusQueue, async () => {
            resolve();
          }),
        );

        if (!enqueued) {
          reject(new Error("status queue is unavailable"));
        }
      });

      expect(observed).toEqual([
        "start:tool-1",
        "start:tool-2",
        "start:tool-3",
        "mutate:tool-1",
        "success:tool-1",
        "mutate:tool-2",
        "success:tool-2",
        "mutate:tool-3",
        "success:tool-3",
      ]);
    } finally {
      await session.dispose();
    }
  });

  test("shutdown flushes queued status and suppresses abort errors", async () => {
    const observed: string[] = [];
    const sink: SessionSink = {
      onError: async (text) => {
        observed.push(`error:${text}`);
      },
      onFinal: async (text) => {
        observed.push(`final:${text}`);
      },
      onRunEnd: async () => {
        observed.push("run-end");
      },
      onRunStart: async () => {
        observed.push("run-start");
      },
      onStatus: async (status) => {
        observed.push(`${status.phase}:${status.toolCallId}`);
      },
      onThinking: async (text) => {
        observed.push(`thinking:${text}`);
      },
    };

    let subscriber: ((event: SessionEvent) => void) | undefined;
    let disposed = false;
    let isStreaming = true;
    const fakeSession = {
      abort: async () => {
        subscriber?.({
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "aborted" }],
        });
        isStreaming = false;
      },
      agent: {
        reset: () => undefined,
        waitForIdle: async () => undefined,
      },
      dispose: () => {
        disposed = true;
      },
      get isStreaming() {
        return isStreaming;
      },
      subscribe: (callback: (event: SessionEvent) => void) => {
        subscriber = callback;
        return () => {
          subscriber = undefined;
        };
      },
    };

    const statusQueue = Effect.runSync(Queue.unbounded<DiscordAction>());
    const mutationQueue = Effect.runSync(Queue.unbounded<DiscordAction>());
    const session = new (PiChannelSession as unknown as new (
      agentSession: typeof fakeSession,
      sink: SessionSink,
      statusQueue: Queue.Queue<DiscordAction>,
      mutationQueue: Queue.Queue<DiscordAction>,
      initialReplyToMessageId: string,
    ) => PiChannelSession)(fakeSession, sink, statusQueue, mutationQueue, "message-1");

    subscriber?.({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
    });

    await session.shutdown();

    expect(observed).toEqual(["start:tool-1", "run-end"]);
    expect(disposed).toBe(true);
  });
});
