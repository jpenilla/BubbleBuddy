import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import { makeDiscordOutputPump, type DiscordOutputPump } from "../src/pi/discord-output-pump.ts";
import { makeSink } from "./utils/session-sink.ts";

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

const makeOutput = (sink: ReturnType<typeof makeSink>) =>
  Effect.runPromise(
    makeDiscordOutputPump({
      getShowThinking: () => false,
      sink,
    }),
  );

describe("channel session Discord output ordering", () => {
  test("processes tool completion statuses between queued Discord mutations", async () => {
    const observed: string[] = [];
    const output = await makeOutput(
      makeSink({
        onStatus: async (status) => {
          observed.push(`${status.phase}:${status.toolCallId}`);
        },
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

  test("dispatches onRunError for message_end with error stopReason", async () => {
    const observed: string[] = [];
    const output = await makeOutput(
      makeSink({
        onRunError: async (msg) => {
          observed.push(`run-error:${msg}`);
        },
      }),
    );

    await runPump(output, async () => {
      output.handleSessionEvent({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "API timeout" },
      } as SessionEvent);
      await Effect.runPromise(output.drain());
    });

    expect(observed).toEqual(["run-error:API timeout"]);
  });

  test("dispatches onRunAborted for message_end with aborted stopReason", async () => {
    const observed: string[] = [];
    const output = await makeOutput(
      makeSink({
        onRunAborted: async () => {
          observed.push("run-aborted");
        },
      }),
    );

    await runPump(output, async () => {
      output.handleSessionEvent({
        type: "message_end",
        message: { role: "assistant", stopReason: "aborted" },
      } as SessionEvent);
      await Effect.runPromise(output.drain());
    });

    expect(observed).toEqual(["run-aborted"]);
  });

  test("dispatches onRetryStatus for auto_retry_start and auto_retry_end", async () => {
    const observed: string[] = [];
    const output = await makeOutput(
      makeSink({
        onRetryStatus: async (status) => {
          const detail =
            status.phase === "retrying"
              ? `:${status.attempt}`
              : status.phase === "failure" && status.finalError !== undefined
                ? `:${status.finalError}`
                : "";
          observed.push(`retry:${status.phase}${detail}`);
        },
      }),
    );

    await runPump(output, async () => {
      output.handleSessionEvent({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: "Rate limited",
      } as SessionEvent);

      output.handleSessionEvent({
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "Still rate limited",
      } as SessionEvent);

      output.handleSessionEvent({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "Rate limited",
      } as SessionEvent);

      output.handleSessionEvent({
        type: "auto_retry_end",
        success: true,
        attempt: 2,
      } as SessionEvent);

      await Effect.runPromise(output.drain());
    });

    expect(observed).toEqual([
      "retry:retrying:1",
      "retry:failure:Still rate limited",
      "retry:retrying:2",
      "retry:success",
    ]);
  });
});
