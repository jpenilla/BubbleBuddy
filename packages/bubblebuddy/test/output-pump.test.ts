import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  ROOT_CONVERSATION_ID,
  type EntryRecord,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "@effect/vitest";
import { type GuildTextBasedChannel } from "discord.js";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { OutputPump } from "../src/discord/output-pump.ts";
import { SessionOutput } from "../src/discord/session-output.ts";
import { type SessionEvent } from "../src/pi/session-events.ts";

const embedDescription = (request: unknown): string =>
  (request as { body: { embeds?: ReadonlyArray<{ description?: string }> } }).body.embeds?.[0]
    ?.description ?? "";

const assistantMessage = (
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage => fauxAssistantMessage("", { stopReason, errorMessage });

const messageEnd = (message: AssistantMessage): SessionEvent => ({
  type: "message_end",
  // The pump reads only the message; durable mints entry IDs itself.
  entry: {
    id: 1 as EntryRecord["id"],
    conversationId: ROOT_CONVERSATION_ID,
    kind: "pi.assistant",
    model: [message],
  },
});

const unansweredRunEnd = (reason: string, detail?: string): SessionEvent => {
  const input = 1 as SubmissionId;
  return {
    type: "run_end",
    inputs: [input],
    settled: {
      id: input,
      conversationId: ROOT_CONVERSATION_ID,
      type: "input",
      status: "unanswered",
      reason,
      detail,
    },
  };
};

const createOutput = Effect.fnUntraced(function* (onDiscordOutput: (description: string) => void) {
  let posted = 0;
  const channel = {
    id: "channel",
    client: {
      options: {},
      rest: {
        post: async (_route: string, request: unknown) => {
          onDiscordOutput(embedDescription(request));
          posted += 1;
          return { id: String(posted) };
        },
        patch: async (_route: string, request: unknown) => {
          onDiscordOutput(embedDescription(request));
        },
      },
    },
  } as unknown as GuildTextBasedChannel;
  const pump = yield* OutputPump.create(channel);
  const handleSessionEvent = yield* SessionOutput.create({
    channel,
    pump,
    showThinking: Effect.succeed(false),
  });
  return { pump, handleSessionEvent };
});

describe("session output pump", () => {
  it.effect("interrupts a running tool Discord action", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const output = yield* createOutput(() => undefined);
          const started = yield* Deferred.make<void>();
          const fiber = yield* output.pump
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
      name: "dispatches model request error output for a run that ends with a model error",
      events: [
        messageEnd(assistantMessage("error", "API timeout")),
        unansweredRunEnd("model_error", "API timeout"),
      ],
      expected: ["❌ **Model request failed**\nAPI timeout"],
    },
    {
      name: "dispatches run aborted output for an aborted run",
      events: [messageEnd(assistantMessage("aborted")), unansweredRunEnd("aborted")],
      expected: ["🛑 **Run aborted**"],
    },
    {
      name: "edits one retry status card across attempts",
      events: [
        { type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "Rate limited" },
        messageEnd(assistantMessage("error", "Rate limited")),
        { type: "auto_retry_end", attempt: 1 },
        { type: "auto_retry_start", attempt: 2, at: 0, errorMessage: "Overloaded" },
        messageEnd(assistantMessage("error", "Overloaded")),
        { type: "auto_retry_end", attempt: 2 },
        messageEnd(assistantMessage("stop")),
      ] satisfies ReadonlyArray<SessionEvent>,
      expected: [
        "🔄 **Retrying** (1/3)...\n- Rate limited",
        "🔄 **Retrying** (2/3)...\n- Rate limited\n- Overloaded",
        "✅ **Retry succeeded after 2 attempts**\n- Rate limited\n- Overloaded",
      ],
    },
  ])("$name", ({ events, expected }) =>
    Effect.gen(function* () {
      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const outputObserved: string[] = [];
          const output = yield* createOutput((description) => outputObserved.push(description));

          for (const event of events) {
            yield* output.handleSessionEvent(event);
          }

          return outputObserved;
        }),
      );
      expect(observed).toEqual(expected);
    }),
  );
});
