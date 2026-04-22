import { describe, expect, test } from "bun:test";

import {
  formatIncomingDiscordMessage,
  normalizeIncomingUserMentions,
  rewriteUsernamesToMentions,
  splitDiscordMessage,
} from "../src/domain/text.ts";

describe("mention normalization", () => {
  test("normalizes Discord user mention ids to usernames", () => {
    const normalized = normalizeIncomingUserMentions(
      "hey <@123> and <@!456>",
      new Map([
        ["123", "alice"],
        ["456", "bob"],
      ]),
    );

    expect(normalized).toBe("hey @alice and @bob");
  });

  test("rewrites plain usernames to Discord mentions when uniquely known", () => {
    const rewritten = rewriteUsernamesToMentions(
      "Talk to @alice but leave @unknown alone.",
      new Map([["alice", "123"]]),
    );

    expect(rewritten).toBe("Talk to <@123> but leave @unknown alone.");
  });

  test("includes the speaking user in normalized incoming Discord messages", () => {
    const formatted = formatIncomingDiscordMessage(
      "jmp",
      "<@123> what's my username?",
      new Map([["123", "bubblebuddy"]]),
    );

    expect(formatted).toBe("Message from @jmp: @bubblebuddy what's my username?");
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
