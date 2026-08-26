import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { DiscordJsError } from "../src/discord/utils.ts";
import { AgentToolError, toPiToolDefinition } from "../src/tools/effect-tool.ts";

const mockCtx = {} as ExtensionContext;

describe("Effect tool adapter", () => {
  test("forwards typed params and preserves structured results", async () => {
    const tool = toPiToolDefinition({
      name: "test_effect_tool",
      label: "Test Effect Tool",
      description: "Tests the Effect tool adapter.",
      parameters: Type.Object({ count: Type.Number() }),
      execute: (_toolCallId, input) =>
        Effect.succeed({
          content: [
            { type: "text", text: `count=${input.count}` },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          details: { count: input.count },
        }),
    });

    await expect(
      tool.execute("tool-call", { count: 3 }, undefined, undefined, mockCtx),
    ).resolves.toEqual({
      content: [
        { type: "text", text: "count=3" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      details: { count: 3 },
    });
  });

  test("preserves tool errors and normalizes unexpected failures", async () => {
    const parameters = Type.Object({});
    const expectedFailure = toPiToolDefinition({
      name: "expected_failure",
      label: "Expected Failure",
      description: "Fails with an agent-actionable error.",
      parameters,
      execute: () => Effect.fail(new AgentToolError({ message: "Message is unavailable." })),
    });
    const unexpectedFailure = toPiToolDefinition({
      name: "unexpected_failure",
      label: "Unexpected Failure",
      description: "Fails unexpectedly.",
      parameters,
      execute: () =>
        Effect.fail(new DiscordJsError({ cause: new Error("sensitive implementation detail") })),
    });
    const defect = toPiToolDefinition({
      name: "defect",
      label: "Defect",
      description: "Dies unexpectedly.",
      parameters,
      execute: () =>
        Effect.sync(() => {
          throw new Error("sensitive defect detail");
        }),
    });

    await expect(
      expectedFailure.execute("tool-call", {}, undefined, undefined, mockCtx),
    ).rejects.toThrow("Message is unavailable.");
    await expect(
      unexpectedFailure.execute("tool-call", {}, undefined, undefined, mockCtx),
    ).rejects.toThrow("This tool encountered an internal error.");
    await expect(defect.execute("tool-call", {}, undefined, undefined, mockCtx)).rejects.toThrow(
      "This tool encountered an internal error.",
    );
  });
});
