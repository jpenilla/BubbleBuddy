import { type Models, type ModelThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import {
  calculateContextTokens,
  estimateContextTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import {
  LiveDoc,
  type ContextView,
  type Conversation,
  type Cursor,
  type EntryRecord,
  type Harness,
  type LiveState,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";

import { tryDurablePromise } from "./durable.ts";

export type SessionActivity = "idle" | "working" | "retrying" | "compacting";

export interface SessionStatus {
  readonly activity: SessionActivity;
  /** A compaction is summarizing while the conversation keeps working. */
  readonly compactingInBackground: boolean;
  /** The conversation's model; `undefined` when it is unset or not in the model catalog. */
  readonly model:
    | {
        readonly name: string;
        readonly provider: string;
        readonly thinkingLevel: ModelThinkingLevel;
      }
    | undefined;
  /** Spend of every model request in this session. */
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
  /** `undefined` without a known model. */
  readonly contextUsage:
    | {
        /** `null` after a compaction until the next answer reports its usage. */
        readonly tokens: number | null;
        readonly contextWindow: number;
        readonly percent: number | null;
      }
    | undefined;
}

/** Messages in the session's whole stored history. */
export interface MessageCounts {
  readonly user: number;
  readonly assistant: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly total: number;
}

const sumUsage = (usages: Iterable<Usage>) => {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  for (const usage of usages) {
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite;
    cost += usage.cost.total;
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return { tokens, cost };
};

const hasMeasuredAnswer = (entry: EntryRecord): boolean =>
  entry.model?.some(
    (message) =>
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      calculateContextTokens(message.usage) > 0,
  ) ?? false;

/** Tokens the next request would send; unknown after a compaction until an answer measures the new context. */
const contextTokens = (view: ContextView): number | null => {
  const head = view.head;
  if (
    head !== undefined &&
    !view.entries.some((entry) => entry.id > head.id && hasMeasuredAnswer(entry))
  )
    return null;
  return estimateContextTokens(view.messages).tokens;
};

const activityOf = (live: LiveState | undefined): SessionActivity => {
  // Only a blocking compaction holds up the conversation; the others run beside it.
  if (live?.compactions?.some((compaction) => compaction.blocking)) return "compacting";
  if (live?.generation?.retry !== undefined) return "retrying";
  if (live?.run !== undefined) return "working";
  return "idle";
};

export interface ReadSessionStatusInput {
  readonly harness: Harness;
  readonly conversation: Conversation;
  /** The catalog the conversation's model is looked up in. */
  readonly models: Models;
}

export const readSessionStatus = Effect.fn("PiSession.status")(function* (
  input: ReadSessionStatusInput,
) {
  const [agent, live, view, usage] = yield* Effect.all(
    [
      tryDurablePromise((context) => input.conversation.agent(context)),
      tryDurablePromise((context) =>
        input.harness.snapshot(LiveDoc, input.conversation.id, context),
      ),
      tryDurablePromise((context) => input.conversation.context(context)),
      tryDurablePromise((context) => input.harness.usage(context)),
    ],
    { concurrency: "unbounded" },
  );
  const model =
    agent.model === undefined
      ? undefined
      : input.models.getModel(agent.model.provider, agent.model.modelId);
  const tokens = contextTokens(view);
  return {
    activity: activityOf(live),
    compactingInBackground: live?.compactions?.some((compaction) => !compaction.blocking) ?? false,
    model:
      model === undefined
        ? undefined
        : { name: model.name, provider: model.provider, thinkingLevel: agent.thinkingLevel },
    ...sumUsage([...Object.values(usage.models), ...Object.values(usage.tools)]),
    contextUsage:
      model === undefined
        ? undefined
        : {
            tokens,
            contextWindow: model.contextWindow,
            percent: tokens === null ? null : (tokens / model.contextWindow) * 100,
          },
  } satisfies SessionStatus;
});

/** Pages through the conversation's stored history, so it costs more as the session grows. */
export const countMessages = Effect.fn("PiSession.countMessages")(function* (
  conversation: Conversation,
) {
  const counts = { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 };
  let cursor: Cursor | undefined;
  do {
    const page = yield* tryDurablePromise((context) =>
      conversation.entries({ order: "ascending" }, 256, cursor, context),
    );
    for (const message of page.items.flatMap((entry) => entry.model ?? [])) {
      counts.total++;
      if (message.role === "user") counts.user++;
      else if (message.role === "toolResult") counts.toolResults++;
      else if (message.role === "assistant") {
        counts.assistant++;
        counts.toolCalls += message.content.filter((block) => block.type === "toolCall").length;
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return counts satisfies MessageCounts;
});
