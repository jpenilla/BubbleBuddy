import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { checkCompactionConfig } from "../src/config/compaction.ts";
import { ConfigFileSchema } from "../src/config/file.ts";

const decodeCompaction = (compaction: unknown) =>
  Schema.decodeUnknownSync(ConfigFileSchema)({ compaction }).compaction;

const model = { provider: "opencode-go", id: "glm-5.3", contextWindow: 1_000_000 };

describe("compaction config", () => {
  it("decodes settings and model overrides", () => {
    const compaction = {
      backgroundTokens: 0,
      modelOverrides: { "opencode-go/glm-5.3": { reserveTokens: 560000 } },
    };
    expect(decodeCompaction(compaction)).toEqual(compaction);
  });

  it.each([{ keepRecentTokens: 1.5 }, { reserveTokens: 0 }, { backgroundTokens: -1 }])(
    "rejects %o",
    (compaction) => {
      expect(() => decodeCompaction(compaction)).toThrow();
    },
  );

  it("accepts the defaults and an override that compacts around 400k", () => {
    expect(checkCompactionConfig(undefined, model)).toBeUndefined();
    const overrides = {
      "opencode-go/glm-5.3": {
        reserveTokens: 560000,
        backgroundTokens: 40000,
        keepRecentTokens: 40000,
      },
    };
    expect(checkCompactionConfig({ modelOverrides: overrides }, model)).toBeUndefined();
  });

  it("rejects settings that would compact every turn", () => {
    expect(checkCompactionConfig({ reserveTokens: 1_000_000 }, model)).toContain("starts at");
    expect(
      checkCompactionConfig(
        { modelOverrides: { "opencode-go/glm-5.3": { keepRecentTokens: 960_000 } } },
        model,
      ),
    ).toContain("keepRecentTokens (960000)");
    expect(
      checkCompactionConfig({ enabled: false, reserveTokens: 1_000_000 }, model),
    ).toBeUndefined();
  });
});
