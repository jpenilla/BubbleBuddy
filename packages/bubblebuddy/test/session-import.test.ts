import { fileURLToPath } from "node:url";

import { type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, ResetEntry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { tryDurablePromise } from "../src/pi/durable.ts";
import {
  importLegacySession,
  INTERRUPTED_TOOL_RESULT,
  readLegacySession,
} from "../src/pi/session-import.ts";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/pi-sessions/${name}.jsonl`, import.meta.url));

const importFixture = (name: string) =>
  Effect.gen(function* () {
    const harness = yield* Effect.acquireRelease(
      tryDurablePromise((context) =>
        Harness.open(
          new MemoryStorage(),
          { models: createModels(), registry: createRegistry() },
          context,
        ),
      ),
      (harness) => tryDurablePromise((context) => harness.close(context)).pipe(Effect.orDie),
    );
    yield* importLegacySession(harness, fixture(name));
    const root = yield* tryDurablePromise((context) => harness.root(context));
    return yield* tryDurablePromise((context) => root.context(context));
  }).pipe(Effect.scoped);

const roles = (messages: readonly Message[]) => messages.map((message) => message.role);

describe("legacy session import", () => {
  it.effect.each(["basic", "tools", "image"])(
    "imports the %s session's messages unchanged",
    (name) =>
      Effect.gen(function* () {
        const legacy = readLegacySession(fixture(name));
        const imported = yield* importFixture(name);

        expect(legacy.summary).toBeUndefined();
        expect(imported.messages).toEqual(legacy.messages);
        expect(roles(imported.messages)).not.toContain("system");
      }),
  );

  it.effect("keeps image content", () =>
    Effect.gen(function* () {
      const imported = yield* importFixture("image");
      const imageBlocks = imported.messages.flatMap((message) =>
        message.role === "assistant" || typeof message.content === "string"
          ? []
          : message.content.filter((block) => block.type === "image"),
      );

      expect(imageBlocks.length).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("starts the context at the compaction summary and keeps later messages", () =>
    Effect.gen(function* () {
      const legacy = readLegacySession(fixture("compacted"));
      const imported = yield* importFixture("compacted");

      expect(legacy.summary).toBeDefined();
      expect(ResetEntry.is(imported.head)).toBe(true);
      expect(imported.messages[0]).toEqual(legacy.summary);
      expect(imported.messages.slice(1)).toEqual(legacy.messages);
      expect(roles(imported.messages).slice(-2)).toEqual(["user", "assistant"]);
    }),
  );

  it.effect("answers a tool call cut off by a crash as interrupted", () =>
    Effect.gen(function* () {
      const imported = yield* importFixture("interrupted");
      const call = imported.messages
        .flatMap((message) => (message.role === "assistant" ? message.content : []))
        .find((block) => block.type === "toolCall");
      const last = imported.messages.at(-1);

      expect(call).toBeDefined();
      expect(last).toMatchObject({
        role: "toolResult",
        toolCallId: call?.id,
        isError: true,
        content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
      });
    }),
  );
});
