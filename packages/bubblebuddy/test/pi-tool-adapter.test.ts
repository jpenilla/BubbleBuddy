import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";

import { DiscordJsError } from "../src/discord/utils.ts";
import { AgentToolError, defineEffectTool } from "../src/pi/effect-tool.ts";
import { toolCall } from "./helpers.ts";

describe("Effect tool adapter", () => {
  test("forwards typed params and preserves structured results", async () => {
    const tool = await Effect.runPromise(
      defineEffectTool({
        name: "test_effect_tool",
        description: "Tests the Effect tool adapter.",
        parameters: Type.Object({ count: Type.Number() }),
        execute: (input) =>
          Effect.succeed({
            content: [
              { type: "text", text: `count=${input.count}` },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
            details: { count: input.count },
          }),
      }),
    );

    await expect(tool.execute({ count: 3 }, toolCall, BACKGROUND_CONTEXT)).resolves.toEqual({
      content: [
        { type: "text", text: "count=3" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      details: { count: 3 },
    });
  });

  test("preserves typed tool errors and normalizes defects", async () => {
    const parameters = Type.Object({});
    const expectedFailure = await Effect.runPromise(
      defineEffectTool({
        name: "expected_failure",
        description: "Fails with an agent-actionable error.",
        parameters,
        execute: () => Effect.fail(new AgentToolError({ message: "Message is unavailable." })),
      }),
    );
    const unexpectedFailure = await Effect.runPromise(
      defineEffectTool({
        name: "unexpected_failure",
        description: "Fails unexpectedly.",
        parameters,
        execute: () =>
          Effect.fail(
            new DiscordJsError({
              message: "Discord operation failed.",
              cause: new Error("sensitive implementation detail"),
            }),
          ),
      }),
    );
    const defect = await Effect.runPromise(
      defineEffectTool({
        name: "defect",
        description: "Dies unexpectedly.",
        parameters,
        execute: () =>
          Effect.sync(() => {
            throw new Error("sensitive defect detail");
          }),
      }),
    );

    await expect(expectedFailure.execute({}, toolCall, BACKGROUND_CONTEXT)).rejects.toThrow(
      "Message is unavailable.",
    );
    await expect(unexpectedFailure.execute({}, toolCall, BACKGROUND_CONTEXT)).rejects.toThrow(
      "Discord operation failed.",
    );
    await expect(defect.execute({}, toolCall, BACKGROUND_CONTEXT)).rejects.toThrow(
      "This tool encountered an internal error.",
    );
  });
});
