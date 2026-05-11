import { describe, expect, test } from "vitest";

import { isActivationMessage } from "../src/discord/activation.ts";

describe("activation rules", () => {
  test.each([
    ["activates when this bot is mentioned", true, true],
    ["ignores messages that do not target this bot", false, false],
  ])("%s", (_name, mentionsBot, expected) => {
    expect(isActivationMessage({ mentionsBot })).toBe(expected);
  });
});
