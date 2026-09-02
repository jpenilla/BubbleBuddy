import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import type { GuildTextBasedChannel } from "discord.js";
import { Deferred, Effect, Exit, Fiber } from "effect";

import {
  createDiscordOutputPump,
  type DiscordOutputPump,
} from "../src/discord/session-output-pump.ts";

type SessionEvent = Parameters<DiscordOutputPump["handleSessionEvent"]>[0];

const embedDescription = (payload: unknown): string => {
  const embed = (payload as { embeds?: readonly unknown[] }).embeds?.[0];
  if (
    typeof embed !== "object" ||
    embed === null ||
    !("toJSON" in embed) ||
    typeof embed.toJSON !== "function"
  ) {
    return "";
  }
  return (embed.toJSON() as { description?: string }).description ?? "";
};

const assistantMessage = (
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage => fauxAssistantMessage("", { stopReason, errorMessage });

const createOutput = (onDiscordOutput: (description: string) => void) => {
  const channel = {
    send: async (payload: unknown) => {
      onDiscordOutput(embedDescription(payload));
      return {
        edit: async (editPayload: unknown) => {
          onDiscordOutput(embedDescription(editPayload));
        },
      };
    },
  };
  return createDiscordOutputPump({
    channel: channel as unknown as GuildTextBasedChannel,
    showThinking: Effect.succeed(false),
  });
};

describe("session output pump", () => {
  it.effect("interrupts a running tool Discord action", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const output = yield* createOutput(() => undefined);
          const started = yield* Deferred.make<void>();
          const fiber = yield* output
            .executeOrdered(
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

  it.effect.each([
    {
      name: "dispatches model request error output for message_end with error stopReason",
      events: [
        {
          type: "message_end",
          message: assistantMessage("error", "API timeout"),
        } satisfies SessionEvent,
      ],
      expected: ["❌ **Model request failed**\nAPI timeout"],
    },
    {
      name: "dispatches run aborted output for message_end with aborted stopReason",
      events: [
        {
          type: "message_end",
          message: assistantMessage("aborted"),
        } satisfies SessionEvent,
      ],
      expected: ["🛑 **Run aborted**"],
    },
    {
      name: "edits one retry status card across attempts",
      events: [
        {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1000,
          errorMessage: "Rate limited",
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
      ] satisfies ReadonlyArray<SessionEvent>,
      expected: [
        "🔄 **Retrying** (1/3)...",
        "🔄 **Retrying** (2/3)...",
        "✅ **Retry succeeded after 2 attempts**",
      ],
    },
  ])("$name", ({ events, expected }) =>
    Effect.gen(function* () {
      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const outputObserved: string[] = [];
          const output = yield* createOutput((description) => outputObserved.push(description));

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
