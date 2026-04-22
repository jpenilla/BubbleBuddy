import { describe, expect, test } from "bun:test";

import { isActivationMessage, shouldTreatAsSteering } from "../src/domain/activation.ts";

describe("activation rules", () => {
  test("ignores bot-authored messages", () => {
    expect(
      isActivationMessage({
        isFromBot: true,
        isReplyToBot: true,
        mentionsBot: true,
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
      isFromBot: false,
      isReplyToBot: true,
      mentionsBot: false,
    };
    expect(shouldTreatAsSteering(context, true)).toBe(true);
    expect(shouldTreatAsSteering(context, false)).toBe(false);
  });
});
