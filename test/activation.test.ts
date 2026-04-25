import { describe, expect, test } from "bun:test";

import { isActivationMessage, shouldTreatAsSteering } from "../src/domain/activation.ts";

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
        isFromBot: false,
        isReplyToBot: false,
        mentionsBot: true,
      }),
    ).toBe(true);
  });

  test("activates on reply to bot", () => {
    expect(
      isActivationMessage({
        isFromBot: false,
        isReplyToBot: true,
        mentionsBot: false,
      }),
    ).toBe(true);
  });

  test("treats activations as steering only while a run is active", () => {
    const context = {
      isReplyToBot: true,
      mentionsBot: false,
    };
    expect(shouldTreatAsSteering(context, true)).toBe(true);
    expect(shouldTreatAsSteering(context, false)).toBe(false);
  });
});
