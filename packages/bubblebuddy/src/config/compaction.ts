import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";

import { type CompactionConfig } from "./file.ts";

export interface CompactionModel {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
}

export interface CompactionCheck {
  /** Settings that would make compaction run constantly or never; startup fails on these. */
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Checks the effective compaction policy for `model` against its context window, merging defaults, harness-wide
 * settings, and the model's override field by field as pi-durable does.
 */
export const checkCompactionConfig = (
  compaction: CompactionConfig | undefined,
  model: CompactionModel,
): CompactionCheck => {
  const modelKey = `${model.provider}/${model.id}`;
  const { modelOverrides = {}, ...harnessWide } = compaction ?? {};
  const override = modelOverrides[modelKey];
  const policy = { ...DEFAULT_COMPACTION_POLICY, ...harnessWide, ...override };

  const warnings = Object.keys(modelOverrides)
    .filter((key) => key !== modelKey)
    .map(
      (key) =>
        `compaction.modelOverrides["${key}"] does not match the configured model "${modelKey}" and is ignored.`,
    );

  const errors: string[] = [];
  if (policy.enabled) {
    const { contextWindow } = model;
    const blockingAt = contextWindow - policy.reserveTokens;
    const backgroundAt = blockingAt - policy.backgroundTokens;
    if (blockingAt <= 0) {
      errors.push(
        `compaction.reserveTokens (${policy.reserveTokens}) must be below the context window of ${modelKey} (${contextWindow}).`,
      );
    } else if (policy.keepRecentTokens >= backgroundAt) {
      // The kept context alone would already be over the threshold, so every turn would compact again.
      errors.push(
        `compaction.keepRecentTokens (${policy.keepRecentTokens}) must be below the point where compaction starts for ${modelKey} (${backgroundAt} = contextWindow ${contextWindow} - reserveTokens ${policy.reserveTokens} - backgroundTokens ${policy.backgroundTokens}).`,
      );
    }
  }
  return { errors, warnings };
};
