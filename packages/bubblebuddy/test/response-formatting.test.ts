import { describe, expect, test } from "vitest";

import {
  formatThinkingStatus,
  splitDiscordMessage,
  splitThinkingStatus,
} from "../src/discord/response-formatting.ts";

describe("status formatting", () => {
  test("formats thinking output with prefix and suffix", () => {
    expect(formatThinkingStatus("Considering options")).toBe(
      "🧠 _Thinking..._\n\nConsidering options\n\n-# ──",
    );
  });

  test("adds the prefix only to the first thinking chunk and the suffix only to the last", () => {
    const chunks = splitThinkingStatus("alpha beta gamma delta", 30);

    expect(chunks).toEqual(["🧠 _Thinking..._\n\nalpha beta ", "gamma delta\n\n-# ──"]);
  });
});

describe("message splitting", () => {
  test.each([
    {
      name: "prefers natural boundaries",
      input: "First paragraph.\n\nSecond paragraph.\nThird paragraph.",
      limit: 30,
      expected: ["First paragraph.\n\n", "Second paragraph.\n", "Third paragraph."],
    },
    {
      name: "reopens code fences across chunks",
      input: "```ts\nconsole.log('hello');\nconsole.log('world');\n```",
      limit: 32,
      expected: ["```ts\nconsole.log('hello');\n\n```", "```ts\nconsole.log('world');\n```"],
    },
  ])("$name", ({ input, limit, expected }) => {
    expect(splitDiscordMessage(input, limit)).toEqual(expected);
  });
});
