import { type Api, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { checkCompactionConfig, ConfigFileSchema } from "../src/config/file.ts";

const decodeCompaction = (compaction: unknown) =>
  Schema.decodeUnknownSync(ConfigFileSchema)({ compaction }).compaction;

const model = {
  provider: "opencode-go",
  id: "glm-5.3",
  contextWindow: 1_000_000,
} as Model<Api>;

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

  it.effect("accepts the defaults and an override that compacts around 400k", () =>
    Effect.gen(function* () {
      yield* checkCompactionConfig(undefined, model);
      yield* checkCompactionConfig(
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
      yield* checkCompactionConfig({ enabled: false, reserveTokens: 1_000_000 }, model);
      // Without a compaction block, or without a known window, nothing is checked.
      yield* checkCompactionConfig(undefined, { ...model, contextWindow: 32_000 });
      yield* checkCompactionConfig({ reserveTokens: 1_000_000 }, { ...model, contextWindow: 0 });
    }),
  );

  it.effect("rejects settings that would compact every turn", () =>
    Effect.gen(function* () {
      const tooMuchReserved = yield* checkCompactionConfig(
        { reserveTokens: 1_000_000 },
        model,
      ).pipe(Effect.flip);
      expect(tooMuchReserved.message).toContain("starts at");

      const keepsTooMuch = yield* checkCompactionConfig(
        { modelOverrides: { "opencode-go/glm-5.3": { keepRecentTokens: 960_000 } } },
        model,
      ).pipe(Effect.flip);
      expect(keepsTooMuch.message).toContain("keepRecentTokens (960000)");
    }),
  );
});
