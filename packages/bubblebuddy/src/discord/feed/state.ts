import { type JsonValue } from "@earendil-works/chord";
import {
  type CompactionReason,
  type CompactionResult,
  type ConversationView,
  defineDoc,
  type EntryId,
  LiveDoc,
  type LiveState,
  type RunFailureReason,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";
import { type Snowflake } from "discord.js";

import { type StandaloneCard } from "./policies.ts";

// Stored as a pi-durable document, so every type here is plain JSON.

/** A tool call's outcome. */
export type ToolResult = {
  isError: boolean;
  details?: JsonValue;
};

/** A grouped tool call's row in its run's tools card. */
export type ToolRow = {
  phase: "running" | "success" | "error";
  callId: string;
  toolName: string;
  description?: string;
  /** The generation that called the tool. */
  generation?: TaskId;
};

/** `attempt`: the last attempt seen retrying; `errors`: each failed attempt's error seen, oldest first. */
export type RetryStatus = {
  phase: "retrying" | "success" | "failure" | "aborted";
  attempt: number;
  errors: string[];
};

export type CompactionProgress = {
  reason: CompactionReason;
  /** Runs while the conversation keeps working, instead of holding it up. */
  background: boolean;
} & (
  | {
      /** `settling`: the compaction left `pi.live`, and its outcome is being looked up; shows as running. */
      phase: "running" | "settling" | "success" | "aborted";
    }
  | { phase: "error"; errorMessage: string }
);

/** A one-off message: how a run ended, or that an answer was cut short. */
export type Notice =
  | { type: "aborted" }
  | { type: "truncated" }
  | { type: "failure"; reason: Exclude<RunFailureReason, "aborted">; message: string };

export type AnswerBlock = { type: "text" | "thinking"; text: string };

/** What an item shows: an answer posts one or more messages, every other item one. */
export type ItemView =
  | { type: "answer"; blocks: AnswerBlock[] }
  | { type: "notice"; notice: Notice }
  | { type: "toolGroup"; rows: ToolRow[] }
  | {
      type: "toolCard";
      toolName: StandaloneCard;
      callId: string;
      generation?: TaskId;
      arguments: JsonValue;
      result?: ToolResult;
    }
  | { type: "retry"; status: RetryStatus }
  | { type: "compaction"; taskId: TaskId<CompactionResult>; status: CompactionProgress };

/** One message, or run of messages, the channel shows for the conversation. */
export type Item = {
  /** Identifies what the item shows across revisions, restarts, and Discord nonces. */
  key: string;
  /** Bumped on every change to how `view` shows. */
  revision: number;
  /** The revision Discord shows; 0 before it is posted. */
  shown: number;
  /** The posted card, for edits. */
  message?: Snowflake;
  view: ItemView;
};

/** The channel's projection of the conversation; stored so a restart resumes where it left off. */
export type FeedState = {
  /** Entries up to here are projected; absent: from the start of the transcript. */
  cursor?: EntryId;
  /** The run being followed, identified by its first input. */
  run?: SubmissionId;
  /** The generation that last answered: it is done retrying, whatever an older live state says. */
  answered?: TaskId;
  /** The run whose failure was last reported; `pi.live` keeps a failure until the next run starts. */
  reportedFailure?: SubmissionId;
  /** The tools card that takes further grouped calls: the last item, until anything follows it in the channel. */
  openGroup?: string;
  /** Items still to post or edit, in channel order. */
  items: Item[];
};

export const isRowFinal = (row: ToolRow) => row.phase !== "running";

/** Whether a view shows as one card, posted once and edited after, rather than as one-off posts. */
export const isCard = (view: ItemView): boolean => view.type !== "answer" && view.type !== "notice";

/** Whether a view no longer changes. */
export const isFinal = (view: ItemView): boolean => {
  switch (view.type) {
    case "answer":
    case "notice":
      return true;
    case "toolGroup":
      return view.rows.every(isRowFinal);
    case "toolCard":
      return view.result !== undefined;
    case "retry":
      return view.status.phase !== "retrying";
    case "compaction":
      return view.status.phase !== "running" && view.status.phase !== "settling";
  }
};

/** Whether Discord does not show an item's latest revision yet. */
export const isPending = (item: Item) => item.shown < item.revision;

/** Records that Discord shows `revision` of an item, in `message` if it is a card. */
export const markShown = (
  state: FeedState,
  key: string,
  revision: number,
  message: Snowflake | undefined,
): FeedState => ({
  ...state,
  items: state.items.map((item) =>
    item.key === key
      ? { ...item, shown: revision, ...(message === undefined ? {} : { message }) }
      : item,
  ),
});

/** Drops final items Discord already shows, except the open tools card. */
export const prune = (state: FeedState): FeedState => {
  const items = state.items.filter(
    (item) => !isFinal(item.view) || isPending(item) || item.key === state.openGroup,
  );
  return items.length === state.items.length ? state : { ...state, items };
};

export const liveState = (view: ConversationView) =>
  view.docs[LiveDoc.definition.kind] as LiveState | undefined;

export const FeedDoc = defineDoc<FeedState>({
  kind: "bubblebuddy.discord-feed",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  // Each commit rewrites the whole state, so every value is a full base.
  checkpointWhen: () => true,
});
