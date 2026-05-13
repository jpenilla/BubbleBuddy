import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import {
  makeDiscordOutputPump,
  type DiscordOutputPump,
} from "../src/pi-session/discord-output-pump.ts";

type SessionEvent = Parameters<DiscordOutputPump["handleSessionEvent"]>[0];

const embedDescription = (payload: unknown): string => {
  const embed = (payload as { embeds?: Array<{ data?: { description?: string } }> }).embeds?.[0];
  return embed?.data?.description ?? "";
};

const makeOutput = (onDiscordOutput: (description: string) => void) => {
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
  return makeDiscordOutputPump({
    channel: channel as never,
    getShowThinking: () => false,
  });
};

describe("channel session Discord output ordering", () => {
  it.effect("interrupts a running tool Discord action", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const output = yield* makeOutput(() => undefined);
          const started = yield* Deferred.make<void>();
          const fiber = yield* output
            .awaitToolDiscordAction(
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never;
              }),
            )
            .pipe(Effect.forkChild({ startImmediately: true }));

          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }),
      );

      expect(Exit.hasInterrupts(exit)).toBe(true);
    }),
  );

  it.effect("processes tool completion statuses between queued Discord mutations", () =>
    Effect.gen(function* () {
      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const outputObserved: string[] = [];
          const output = yield* makeOutput((description) => {
            if (description.includes("**bash**")) {
              outputObserved.push(description.includes("⏳") ? "start" : "success");
            }
          });
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

          yield* Effect.forEach(
            toolIds,
            (toolCallId) =>
              Effect.gen(function* () {
                yield* output.awaitToolDiscordAction(
                  Effect.sync(() => {
                    outputObserved.push(`mutate:${toolCallId}`);
                  }),
                );
                emit({
                  type: "tool_execution_end",
                  toolCallId,
                  toolName: "bash",
                } as SessionEvent);
              }),
            { concurrency: "unbounded" },
          );

          return outputObserved;
        }),
      );

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
    }),
  );

  it.effect.each([
    {
      name: "dispatches run error output for message_end with error stopReason",
      events: [
        {
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: "API timeout" },
        } as SessionEvent,
      ],
      expected: ["❌ **Run failed**\nAPI timeout"],
    },
    {
      name: "dispatches run aborted output for message_end with aborted stopReason",
      events: [
        {
          type: "message_end",
          message: { role: "assistant", stopReason: "aborted" },
        } as SessionEvent,
      ],
      expected: ["🛑 **Run aborted**"],
    },
    {
      name: "dispatches retry status output for auto_retry_start and auto_retry_end",
      events: [
        {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1000,
          errorMessage: "Rate limited",
        },
        {
          type: "auto_retry_end",
          success: false,
          attempt: 1,
          finalError: "Still rate limited",
        },
        {
          type: "auto_retry_start",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 2000,
          errorMessage: "Rate limited",
        },
        {
          type: "auto_retry_end",
          success: true,
          attempt: 2,
        },
      ] as ReadonlyArray<SessionEvent>,
      expected: [
        "🔄 **Retrying** (attempt 1)",
        "❌ **Retry failed** — Still rate limited",
        "🔄 **Retrying** (attempt 2)",
        "✅ **Retry succeeded**",
      ],
    },
  ])("$name", ({ events, expected }) =>
    Effect.gen(function* () {
      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const outputObserved: string[] = [];
          const output = yield* makeOutput((description) => outputObserved.push(description));

          for (const event of events) {
            output.handleSessionEvent(event);
          }

          return outputObserved;
        }),
      );
      expect(observed).toEqual(expected);
    }),
  );
});
