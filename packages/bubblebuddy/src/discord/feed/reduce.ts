import { isDeepStrictEqual } from "node:util";

import { copyJson } from "@earendil-works/chord";
import {
  type AssistantMessage,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  type CompactionResult,
  type ConversationView,
  type EntryId,
  type EntryRecord,
  type LiveState,
  type RunFailure,
  type RunFailureReason,
  type SubmissionId,
  type TaskId,
  type TaskOutcome,
} from "@earendil-works/pi-durable";

import { ToolPolicy } from "./policies.ts";
import {
  type AnswerBlock,
  type CompactionProgress,
  type FeedState,
  type ItemView,
  isFinal,
  isRowFinal,
  liveState,
  type RetryStatus,
  type ToolResult,
  type ToolRow,
} from "./state.ts";
import { formatToolDescription } from "./tool-description.ts";

/** What to project: thinking is left out unless it is shown. */
export interface Options {
  readonly showThinking: boolean;
}

const MAX_TOOLS_PER_GROUP = 8;

/** Closes the open tools card: whatever comes next in the channel follows it. */
const closeGroup = (next: FeedState) => {
  delete next.openGroup;
};

const append = (next: FeedState, key: string, view: ItemView) => {
  closeGroup(next);
  next.items.push({ key, revision: 1, shown: 0, view });
};

/** Replaces the view of the item at `index`, as a new revision. */
const revise = (next: FeedState, index: number, view: ItemView) => {
  const item = next.items[index];
  next.items[index] = { ...item, view, revision: item.revision + 1 };
};

const findIndex = (next: FeedState, key: string) =>
  next.items.findIndex((item) => item.key === key);

// Item keys: stored, and part of each post's Discord nonce.

const answerKey = (entry: EntryId) => `answer:${entry}`;

const truncatedKey = (entry: EntryId) => `truncated:${entry}`;

/** Tool calls are keyed by their answer too: some providers reuse call IDs across rounds. */
const toolGroupKey = (entry: EntryId, callId: string) => `toolGroup:${entry}:${callId}`;

const toolCardKey = (entry: EntryId, callId: string) => `toolCard:${entry}:${callId}`;

const failureKey = (run: SubmissionId) => `failure:${run}`;

/** Each generation, one per tool round, retries on its own card. */
const retryKey = (generation: TaskId) => `retry:${generation}`;

const compactionKey = (taskId: TaskId<CompactionResult>) => `compaction:${taskId}`;

// Transcript

const answerBlocks = (message: AssistantMessage, { showThinking }: Options): AnswerBlock[] =>
  message.content.flatMap((block): AnswerBlock[] => {
    if (block.type === "text" && block.text.trim().length > 0) {
      return [{ type: "text", text: block.text }];
    }
    if (showThinking && block.type === "thinking" && block.thinking.trim().length > 0) {
      return [{ type: "thinking", text: block.thinking.trim() }];
    }
    return [];
  });

const addToolRow = (next: FeedState, entry: EntryId, row: ToolRow) => {
  const last = next.items.at(-1);
  if (
    last?.view.type === "toolGroup" &&
    last.key === next.openGroup &&
    last.view.rows.length < MAX_TOOLS_PER_GROUP
  ) {
    revise(next, next.items.length - 1, { ...last.view, rows: [...last.view.rows, row] });
    return;
  }
  const key = toolGroupKey(entry, row.callId);
  append(next, key, { type: "toolGroup", rows: [row] });
  next.openGroup = key;
};

const projectToolCall = (next: FeedState, entry: EntryRecord, call: ToolCall) => {
  const generation = entry.byTaskId;
  const calledBy = generation === undefined ? {} : { generation };
  if (ToolPolicy.isStandaloneCard(call.name)) {
    const view: ItemView = {
      type: "toolCard",
      toolName: call.name,
      callId: call.id,
      arguments: copyJson(call.arguments, { omitUndefinedProperties: true }),
      ...calledBy,
    };
    append(next, toolCardKey(entry.id, call.id), view);
    return;
  }
  if (ToolPolicy.forTool(call.name) !== "grouped") return;
  const description = formatToolDescription(call.name, call.arguments);
  addToolRow(next, entry.id, {
    phase: "running",
    callId: call.id,
    toolName: call.name,
    ...(description === undefined ? {} : { description }),
    ...calledBy,
  });
};

/** Finishes the retry card at `index`, keeping the attempt it last showed, with `error` appended. */
const finishRetryAt = (
  next: FeedState,
  index: number,
  phase: Exclude<RetryStatus["phase"], "retrying">,
  error?: string,
) => {
  const item = next.items[index];
  if (item?.view.type !== "retry" || isFinal(item.view)) return false;
  const { attempt, errors } = item.view.status;
  const status = { phase, attempt, errors: error === undefined ? errors : [...errors, error] };
  revise(next, index, { type: "retry", status });
  return true;
};

const finishRetry = (
  next: FeedState,
  generation: TaskId,
  phase: Exclude<RetryStatus["phase"], "retrying">,
  error?: string,
) => finishRetryAt(next, findIndex(next, retryKey(generation)), phase, error);

/** Whether a message is an answer, as opposed to a failed or cut-off attempt, which a retry or the run's failure reports. */
const isAnswer = ({ stopReason }: AssistantMessage) =>
  stopReason === "stop" || stopReason === "length" || stopReason === "toolUse";

const projectAnswer = (
  next: FeedState,
  entry: EntryRecord,
  message: AssistantMessage,
  options: Options,
) => {
  if (!isAnswer(message)) return;
  const generation = entry.byTaskId;
  if (generation !== undefined) {
    finishRetry(next, generation, "success");
    next.answered = generation;
  }
  const blocks = answerBlocks(message, options);
  if (blocks.length > 0) append(next, answerKey(entry.id), { type: "answer", blocks });
  for (const block of message.content) {
    if (block.type === "toolCall") projectToolCall(next, entry, block);
  }
  if (message.stopReason === "length") {
    append(next, truncatedKey(entry.id), { type: "notice", notice: { type: "truncated" } });
  }
};

const isUnsettledCall = (callId: string) => (row: ToolRow) =>
  row.callId === callId && !isRowFinal(row);

/**
 * Settles a call's row or card with its result; only a standalone card shows the result's details. The latest
 * unsettled call with the ID is the one: some providers reuse call IDs across rounds.
 */
const settleToolCall = (next: FeedState, message: ToolResultMessage) => {
  const unsettled = isUnsettledCall(message.toolCallId);
  const index = next.items.findLastIndex(
    ({ view }) =>
      (view.type === "toolGroup" && view.rows.some(unsettled)) ||
      (view.type === "toolCard" && view.callId === message.toolCallId && view.result === undefined),
  );
  const item = next.items[index];
  if (item === undefined) return;
  if (item.view.type === "toolCard") {
    const result: ToolResult =
      message.details === undefined
        ? { isError: message.isError }
        : {
            isError: message.isError,
            details: copyJson(message.details, { omitUndefinedProperties: true }),
          };
    revise(next, index, { ...item.view, result });
  } else if (item.view.type === "toolGroup") {
    const phase: ToolRow["phase"] = message.isError ? "error" : "success";
    const rows = item.view.rows.map((row) => (unsettled(row) ? { ...row, phase } : row));
    revise(next, index, { ...item.view, rows });
  }
};

const projectEntry = (next: FeedState, entry: EntryRecord, options: Options) => {
  const message = entry.model?.[0];
  if (message?.role === "assistant") projectAnswer(next, entry, message, options);
  else if (message?.role === "toolResult") {
    settleToolCall(next, message);
    // The tool's post is in the channel now: later calls go below it.
    if (ToolPolicy.forTool(message.toolName) === "posts") closeGroup(next);
  }
};

// pi.live

/** Why a run that ended without an answer failed. */
const failureMessage = (
  reason: Exclude<RunFailureReason, "aborted">,
  detail: string | undefined,
): string => {
  const suffix = detail === undefined ? "" : `: ${detail}`;
  switch (reason) {
    case "model_error":
      return detail ?? "The model request failed without an error message";
    case "no_model":
      return `No model is available${suffix}`;
    case "reset":
      return "The context was reset before an answer";
    case "faulted":
      return `The run hit an unrecoverable error${suffix}`;
    case "orphaned":
      return `The run could not continue${suffix}`;
    case "interrupted":
      return `The bot stopped while the model was answering${suffix}`;
    case "restart_limit":
      return `The model request was cut off too many times${suffix}`;
    case "nothing_to_answer":
      return "There was nothing to answer";
    case "turn_limit":
      return `Reached the tool round limit${suffix}`;
  }
};

/** Reports how a run ended without an answer: on its retry card, or else as a notice. */
const reportFailure = (
  next: FeedState,
  { reason, detail, taskId }: RunFailure,
  run: SubmissionId,
) => {
  next.reportedFailure = run;
  // `taskId`: the failed run's last generation, whose retry card reports it.
  if (reason === "aborted") {
    if (!finishRetry(next, taskId, "aborted")) {
      append(next, failureKey(run), { type: "notice", notice: { type: "aborted" } });
    }
    return;
  }
  const message = failureMessage(reason, detail);
  if (!finishRetry(next, taskId, "failure", message)) {
    append(next, failureKey(run), { type: "notice", notice: { type: "failure", reason, message } });
  }
};

/**
 * The followed run ended: its tools card is done, its calls without a result never got one, and a retry card it left
 * retrying failed without a reported failure. `current`: the live run's generation, whose calls an earlier view may
 * already show, still running.
 */
const endRun = (next: FeedState, current: TaskId | undefined) => {
  const ended = (generation: TaskId | undefined) =>
    generation === undefined || generation !== current;
  const unfinished = (row: ToolRow) => !isRowFinal(row) && ended(row.generation);
  closeGroup(next);
  next.items.forEach((item, index) => {
    const { view } = item;
    if (view.type === "toolGroup" && view.rows.some(unfinished)) {
      const rows = view.rows.map((row): ToolRow =>
        unfinished(row) ? { ...row, phase: "error" } : row,
      );
      revise(next, index, { ...view, rows });
    } else if (view.type === "toolCard" && view.result === undefined && ended(view.generation)) {
      revise(next, index, { ...view, result: { isError: true } });
    } else if (view.type === "retry") {
      finishRetryAt(next, index, "failure");
    }
  });
  delete next.run;
};

const followRun = (next: FeedState, live: LiveState) => {
  const id = live.run?.inputs[0];
  if (next.run !== undefined && next.run !== id) endRun(next, live.run?.taskId);
  if (live.run === undefined || id === undefined) return;
  next.run = id;
};

/** Each generation, one per tool round, has its own attempts and retry card. */
const projectRetry = (next: FeedState, live: LiveState, runGeneration: TaskId) => {
  const generation = live.generation;
  // An answered generation is done retrying: its answer can come before the live state that retried.
  if (generation?.retry === undefined || runGeneration === next.answered) return;
  const key = retryKey(runGeneration);
  const index = findIndex(next, key);
  const item = next.items[index];
  const card = item?.view.type === "retry" ? item.view : undefined;
  if (card !== undefined && isFinal(card)) return;
  const { attempt } = generation;
  const seen = card?.status ?? { attempt: 0, errors: [] };
  // `pi.live` holds only the latest attempt's error: record it once, when that attempt is first seen.
  const errors = attempt > seen.attempt ? [...seen.errors, generation.retry.error] : seen.errors;
  const status: RetryStatus = { phase: "retrying", attempt, errors };
  if (card === undefined) append(next, key, { type: "retry", status });
  else if (!isDeepStrictEqual(card.status, status)) revise(next, index, { type: "retry", status });
};

const projectCompactions = (next: FeedState, live: LiveState) => {
  const running = live.compactions ?? [];
  for (const compaction of running) {
    const key = compactionKey(compaction.taskId);
    if (findIndex(next, key) !== -1) continue;
    append(next, key, {
      type: "compaction",
      taskId: compaction.taskId,
      status: { phase: "running", reason: compaction.trigger, background: !compaction.blocking },
    });
  }
  next.items = next.items.map((item) => {
    const { view } = item;
    // Not a new revision: a settling compaction shows as running.
    return view.type === "compaction" &&
      view.status.phase === "running" &&
      !running.some(({ taskId }) => taskId === view.taskId)
      ? { ...item, view: { ...view, status: { ...view.status, phase: "settling" } } }
      : item;
  });
};

/** The state for a channel attaching to `view` without a stored projection: history before it stays unposted. */
export const attach = (view: ConversationView): FeedState => {
  const cursor = view.entries.at(-1)?.id ?? view.before;
  const reportedFailure = liveState(view)?.runFailure?.inputs[0];
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(reportedFailure === undefined ? {} : { reportedFailure }),
    items: [],
  };
};

/** Applies `project` to a copy of `state`; most changes, such as streamed text, change nothing the channel shows. */
const update = (state: FeedState, project: (next: FeedState) => void): FeedState => {
  const next: FeedState = { ...state, items: [...state.items] };
  project(next);
  return isDeepStrictEqual(next, state) ? state : next;
};

const applyEntries = (next: FeedState, entries: readonly EntryRecord[], options: Options) => {
  for (const entry of entries) {
    if (next.cursor !== undefined && entry.id <= next.cursor) continue;
    projectEntry(next, entry, options);
    next.cursor = entry.id;
  }
};

const applyLive = (next: FeedState, live: LiveState) => {
  const failure = live.runFailure;
  const failedRun = failure?.inputs[0];
  if (failure !== undefined && failedRun !== undefined && failedRun !== next.reportedFailure) {
    reportFailure(next, failure, failedRun);
  }
  followRun(next, live);
  if (next.run !== undefined && live.run !== undefined) projectRetry(next, live, live.run.taskId);
  projectCompactions(next, live);
};

/**
 * Projects the entries after the cursor alone, for a reader outside the ordered revisions: their live state is
 * applied by `reduce`, so a newer live state is never overwritten by an older one.
 */
export const reduceEntries = (
  state: FeedState,
  entries: readonly EntryRecord[],
  options: Options,
): FeedState => update(state, (next) => applyEntries(next, entries, options));

/** Projects a revision of the conversation, in revision order: its entries after the cursor, then its live state. */
export const reduce = (state: FeedState, view: ConversationView, options: Options): FeedState =>
  update(state, (next) => {
    applyEntries(next, view.entries, options);
    applyLive(next, liveState(view) ?? {});
  });

const settledStatus = (
  { reason, background }: CompactionProgress,
  outcome: TaskOutcome<CompactionResult> | undefined,
): CompactionProgress => {
  switch (outcome?.status) {
    case undefined:
      return { phase: "error", reason, background, errorMessage: "Could not read how it ended" };
    case "completed":
      return outcome.result.entryId === undefined && outcome.result.submissionId === undefined
        ? {
            phase: "error",
            reason,
            background,
            errorMessage: "Nothing to compact (session too small)",
          }
        : { phase: "success", reason, background };
    case "aborted":
      return { phase: "aborted", reason, background };
    case "failed":
    case "faulted":
      return { phase: "error", reason, background, errorMessage: outcome.error.message };
    case "orphaned":
      return { phase: "error", reason, background, errorMessage: outcome.reason };
  }
};

/** Settles a compaction that left `pi.live` with its task's outcome; `undefined` when it could not be read. */
export const settleCompaction = (
  state: FeedState,
  taskId: TaskId<CompactionResult>,
  outcome: TaskOutcome<CompactionResult> | undefined,
): FeedState =>
  update(state, (next) => {
    const index = findIndex(next, compactionKey(taskId));
    const item = next.items[index];
    if (item?.view.type !== "compaction") return;
    const status = settledStatus(item.view.status, outcome);
    revise(next, index, { ...item.view, status });
  });
