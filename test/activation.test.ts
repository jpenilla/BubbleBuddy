import { describe, expect, test } from "bun:test";

import { isActivationMessage } from "../src/discord/activation.ts";

describe("activation rules", () => {
  test("activates when another bot mentions or replies to this bot", () => {
    expect(
      isActivationMessage({
        isReplyToBot: true,
        mentionsBot: true,
      }),
    ).toBe(true);
  });

  test("ignores messages that don't target this bot", () => {
    expect(
      isActivationMessage({
        isReplyToBot: false,
        mentionsBot: false,
      }),
    ).toBe(false);
  });

  test("activates on mention", () => {
    expect(
      isActivationMessage({
        isReplyToBot: false,
        mentionsBot: true,
      }),
    ).toBe(true);
  });

  test("activates on reply to bot", () => {
    expect(
      isActivationMessage({
        isReplyToBot: true,
        mentionsBot: false,
      }),
    ).toBe(true);
  });
});
