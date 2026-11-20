import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";

import { type CompactionConfig } from "./file.ts";

/**
 * Returns an error when the effective compaction policy for the model would compact every turn: the context
 * kept after a compaction must fit below the point where the next one starts.
 */
export const checkCompactionConfig = (
  compaction: CompactionConfig | undefined,
  model: { readonly provider: string; readonly id: string; readonly contextWindow: number },
): string | undefined => {
  const { modelOverrides, ...harnessWide } = compaction ?? {};
  const policy = {
    ...DEFAULT_COMPACTION_POLICY,
    ...harnessWide,
    ...modelOverrides?.[`${model.provider}/${model.id}`],
  };
  const startsAt = model.contextWindow - policy.reserveTokens - policy.backgroundTokens;
  if (policy.enabled && policy.keepRecentTokens >= startsAt) {
    return `Compaction for ${model.provider}/${model.id} starts at ${startsAt} tokens (contextWindow ${model.contextWindow} - reserveTokens ${policy.reserveTokens} - backgroundTokens ${policy.backgroundTokens}), which must be above keepRecentTokens (${policy.keepRecentTokens}).`;
  }
  return undefined;
};
