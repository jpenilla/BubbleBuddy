import { describe, expect, test } from "vitest";

import {
  formatIncomingDiscordMessage,
  normalizeIncomingUserMentions,
} from "../src/discord/prompt-formatting.ts";

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
