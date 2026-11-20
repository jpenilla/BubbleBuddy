import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { checkCompactionConfig } from "../src/config/compaction.ts";
import { ConfigFileSchema } from "../src/config/file.ts";

const decode = Schema.decodeUnknownSync(ConfigFileSchema);
const decodeCompaction = (compaction: unknown) => decode({ compaction }).compaction;

const model = { provider: "opencode-go", id: "glm-5.3", contextWindow: 1_000_000 };

describe("compaction config decoding", () => {
  it("leaves compaction unset when omitted", () => {
    expect("compaction" in decode({})).toBe(false);
  });

  it("decodes harness-wide settings and model overrides", () => {
    const compaction = {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      backgroundTokens: 0,
      modelOverrides: { "opencode-go/glm-5.3": { reserveTokens: 560000 } },
    };
    expect(decodeCompaction(compaction)).toEqual(compaction);
  });

  it.each([
    ["non-integer", { keepRecentTokens: 1.5 }],
    ["zero keepRecentTokens", { keepRecentTokens: 0 }],
    ["negative backgroundTokens", { backgroundTokens: -1 }],
    ["reserveTokens below the minimum", { reserveTokens: 1000 }],
    ["a misspelled key", { reservedTokens: 20000 }],
    ["a misspelled override key", { modelOverrides: { "a/b": { reservedTokens: 20000 } } }],
    ["an override key without a provider", { modelOverrides: { "glm-5.3": {} } }],
    ["null", { reserveTokens: null }],
  ])("rejects %s", (_, compaction) => {
    expect(() => decodeCompaction(compaction)).toThrow();
  });
});

describe("checkCompactionConfig", () => {
  it("accepts the defaults", () => {
    expect(checkCompactionConfig(undefined, model)).toEqual({ errors: [], warnings: [] });
  });

  it("accepts an override that compacts around 400k", () => {
    const result = checkCompactionConfig(
      {
        modelOverrides: {
          "opencode-go/glm-5.3": {
            reserveTokens: 560000,
            backgroundTokens: 40000,
            keepRecentTokens: 40000,
          },
        },
      },
      model,
    );
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("rejects reserveTokens at or above the context window", () => {
    const { errors } = checkCompactionConfig({ reserveTokens: 1_000_000 }, model);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("reserveTokens");
  });

  it("rejects keepRecentTokens that would not fit below the compaction start", () => {
    const { errors } = checkCompactionConfig(
      { reserveTokens: 900_000, backgroundTokens: 50_000, keepRecentTokens: 50_000 },
      model,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("keepRecentTokens");
  });

  it("applies the matching override over harness-wide settings", () => {
    const { errors } = checkCompactionConfig(
      {
        reserveTokens: 1_000_000,
        modelOverrides: { "opencode-go/glm-5.3": { reserveTokens: 16384 } },
      },
      model,
    );
    expect(errors).toEqual([]);
  });

  it("skips threshold checks when automatic compaction is disabled", () => {
    const { errors } = checkCompactionConfig({ enabled: false, reserveTokens: 2_000_000 }, model);
    expect(errors).toEqual([]);
  });

  it("warns about overrides for other models", () => {
    const { warnings } = checkCompactionConfig(
      { modelOverrides: { "opencode-go/deepseek-v4.1-flash": { reserveTokens: 560000 } } },
      model,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("opencode-go/deepseek-v4.1-flash");
  });
});
