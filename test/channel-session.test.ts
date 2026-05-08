import { describe, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";

import { makeDiscordOutputPump, type DiscordOutputPump } from "../src/pi/discord-output-pump.ts";

type SessionEvent = Parameters<DiscordOutputPump["handleSessionEvent"]>[0];

const runPump = async <T>(
  setup: { output: DiscordOutputPump; close: () => Promise<void> },
  use: (output: DiscordOutputPump) => Promise<T>,
): Promise<T> => {
  try {
    return await use(setup.output);
  } finally {
    await setup.close();
  }
};

const embedDescription = (payload: unknown): string => {
  const embed = (payload as { embeds?: Array<{ data?: { description?: string } }> }).embeds?.[0];
  return embed?.data?.description ?? "";
};

const makeOutput = async (onDiscordOutput: (description: string) => void) => {
  const scope = await Effect.runPromise(Scope.make());
  const channel = {
    sendTyping: async () => undefined,
    send: async (payload: unknown) => {
      onDiscordOutput(embedDescription(payload));
      return {
        edit: async (editPayload: unknown) => {
          onDiscordOutput(embedDescription(editPayload));
        },
      };
    },
  };
  const output = await Effect.runPromise(
    makeDiscordOutputPump({
      channel: channel as never,
      config: { typingIndicatorIntervalMs: 60_000 } as never,
      getShowThinking: () => false,
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return {
    output,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};

describe("channel session Discord output ordering", () => {
  test("processes tool completion statuses between queued Discord mutations", async () => {
    const observed: string[] = [];
    const setup = await makeOutput((description) => {
      if (description.includes("**bash**")) {
        observed.push(description.includes("⏳") ? "start" : "success");
      }
    });

    await runPump(setup, async (output) => {
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
            await Effect.runPromise(
              output.awaitToolDiscordAction(
                Effect.sync(() => {
                  observed.push(`mutate:${toolCallId}`);
                }),
              ),
            );
            emit({
              type: "tool_execution_end",
              toolCallId,
              toolName: "bash",
            } as SessionEvent);
          })(),
        ),
      );
    });

    expect(observed).toEqual([
      "start",
      "start",
      "start",
      "mutate:tool-1",
      "success",
      "mutate:tool-2",
      "success",
      "mutate:tool-3",
      "success",
    ]);
  });

  test("dispatches run error output for message_end with error stopReason", async () => {
    const observed: string[] = [];
    const setup = await makeOutput((description) => observed.push(description));

    await runPump(setup, async (output) => {
      output.handleSessionEvent({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "API timeout" },
      } as SessionEvent);
    });

    expect(observed).toEqual(["❌ **Run failed**\nAPI timeout"]);
  });

  test("dispatches run aborted output for message_end with aborted stopReason", async () => {
    const observed: string[] = [];
    const setup = await makeOutput((description) => observed.push(description));

    await runPump(setup, async (output) => {
      output.handleSessionEvent({
        type: "message_end",
        message: { role: "assistant", stopReason: "aborted" },
      } as SessionEvent);
    });

    expect(observed).toEqual(["🛑 **Run aborted**"]);
  });

  test("dispatches retry status output for auto_retry_start and auto_retry_end", async () => {
    const observed: string[] = [];
    const setup = await makeOutput((description) => observed.push(description));

    await runPump(setup, async (output) => {
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
    });

    expect(observed).toEqual([
      "🔄 **Retrying** (attempt 1)",
      "❌ **Retry failed** — Still rate limited",
      "🔄 **Retrying** (attempt 2)",
      "✅ **Retry succeeded**",
    ]);
  });
});
