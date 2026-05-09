import { describe, expect, test } from "vitest";

import { isActivationMessage } from "../src/discord/activation.ts";

describe("activation rules", () => {
  test("activates when another bot mentions this bot", () => {
    expect(
      isActivationMessage({
        mentionsBot: true,
      }),
    ).toBe(true);
  });

  test("ignores messages that don't target this bot", () => {
    expect(
      isActivationMessage({
        mentionsBot: false,
      }),
    ).toBe(false);
  });

  test("activates on mention", () => {
    expect(
      isActivationMessage({
        mentionsBot: true,
      }),
    ).toBe(true);
  });

  test("ignores non-ping reply to bot", () => {
    expect(
      isActivationMessage({
        mentionsBot: false,
      }),
    ).toBe(false);
  });
});
