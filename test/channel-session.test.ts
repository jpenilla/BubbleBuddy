import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import { DiscordOutputPump, type SessionSink } from "../src/pi/discord-output-pump.ts";

type SessionEvent = Parameters<DiscordOutputPump["handleSessionEvent"]>[0];

const runPump = async <T>(output: DiscordOutputPump, use: () => Promise<T>): Promise<T> => {
  const worker = Effect.runFork(output.run());
  try {
    return await use();
  } finally {
    await Effect.runPromise(output.shutdownQueues());
    await Effect.runPromise(Fiber.interrupt(worker));
  }
};

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

    const output = await Effect.runPromise(
      DiscordOutputPump.make({
        getChannelSettings: () => ({}),
        initialReplyToMessageId: "message-1",
        sink,
      }),
    );

    await runPump(output, async () => {
      const emit = (event: SessionEvent): void => {
        output.handleSessionEvent(event);
      };

      const toolIds = ["tool-1", "tool-2", "tool-3"];
      for (const toolCallId of toolIds) {
        emit({
          type: "tool_execution_start",
          toolCallId,
          toolName: "bash",
        } as SessionEvent);
      }

      await Promise.all(
        toolIds.map((toolCallId) =>
          (async () => {
            await output.runDiscordAction(async () => {
              observed.push(`mutate:${toolCallId}`);
            });
            emit({
              type: "tool_execution_end",
              toolCallId,
              toolName: "bash",
            } as SessionEvent);
          })(),
        ),
      );

      await Effect.runPromise(output.drain());
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
  });

  test("shutdown drains queued status and suppresses abort errors", async () => {
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

    const output = await Effect.runPromise(
      DiscordOutputPump.make({
        getChannelSettings: () => ({}),
        initialReplyToMessageId: "message-1",
        sink,
      }),
    );

    await runPump(output, async () => {
      output.handleSessionEvent({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
      } as SessionEvent);

      output.setShuttingDown(true);
      output.handleSessionEvent({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "aborted" }],
      } as SessionEvent);

      await Effect.runPromise(output.drain());
    });

    expect(observed).toEqual(["start:tool-1", "run-end"]);
  });
});
