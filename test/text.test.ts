import { describe, expect, test } from "vitest";

import {
  formatIncomingDiscordMessage,
  formatThinkingStatus,
  normalizeIncomingUserMentions,
  splitDiscordMessage,
  splitThinkingStatus,
} from "../src/domain/text.ts";

describe("mention normalization", () => {
  test("normalizes Discord user mention ids to copyable mention references", () => {
    const normalized = normalizeIncomingUserMentions(
      "hey <@123> and <@!456>",
      new Map([
        ["123", "alice"],
        ["456", "bob"],
      ]),
    );

    expect(normalized).toBe("hey @alice mention=<@123> and @bob mention=<@456>");
  });

  test("formats incoming Discord messages with compact copyable mention references", () => {
    const formatted = formatIncomingDiscordMessage(
      "555",
      "jmp",
      "999",
      "<@123> what's my username?",
      new Map([["123", "bubblebuddy"]]),
    );

    expect(formatted).toBe(
      "[msg 555 user=jmp mention=<@999>] @bubblebuddy mention=<@123> what's my username?",
    );
  });

  test("includes reply reference when provided", () => {
    const formatted = formatIncomingDiscordMessage(
      "111",
      "alice",
      "222",
      "Hello there",
      new Map(),
      "789",
    );

    expect(formatted).toBe("[msg 111 user=alice mention=<@222> reply_to=789] Hello there");
  });

  test("includes reply reference for empty content", () => {
    const formatted = formatIncomingDiscordMessage("111", "alice", "222", "", new Map(), "789");

    expect(formatted).toBe("[msg 111 user=alice mention=<@222> reply_to=789]");
  });

  test("omits reply reference when not provided", () => {
    const formatted = formatIncomingDiscordMessage("111", "alice", "222", "Hello there", new Map());

    expect(formatted).toBe("[msg 111 user=alice mention=<@222>] Hello there");
  });
});

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
  test("prefers natural boundaries", () => {
    const chunks = splitDiscordMessage(
      "First paragraph.\n\nSecond paragraph.\nThird paragraph.",
      30,
    );

    expect(chunks).toEqual(["First paragraph.\n\n", "Second paragraph.\n", "Third paragraph."]);
  });

  test("reopens code fences across chunks", () => {
    const chunks = splitDiscordMessage(
      "```ts\nconsole.log('hello');\nconsole.log('world');\n```",
      32,
    );

    expect(chunks).toEqual([
      "```ts\nconsole.log('hello');\n\n```",
      "```ts\nconsole.log('world');\n```",
    ]);
  });
});
