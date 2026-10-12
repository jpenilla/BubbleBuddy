import { type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  type ConversationId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import { Effect, FileSystem, Schema } from "effect";

import { tryDurablePromise } from "./durable.ts";

export class LegacySessionReadError extends Schema.TaggedError<LegacySessionReadError>()(
  "LegacySessionReadError",
  {
    file: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const LEGACY_SESSION_FILE_EXTENSION = ".jsonl";

export const INTERRUPTED_TOOL_RESULT =
  "The tool call was interrupted before it returned a result. It may have partially run.";

export interface LegacySessionContext {
  /** Compaction summary that starts the active context, as a user message. */
  readonly summary: Message | undefined;
  readonly messages: readonly Message[];
}

/** Every tool call of a tool-using answer gets a result; unanswered calls are reported as interrupted. */
const closeToolCalls = (messages: readonly Message[]): Message[] => {
  const closed: Message[] = [];
  const open = new Map<string, string>();
  let openedAt = 0;
  const closeOpen = () => {
    for (const [toolCallId, toolName] of open) {
      closed.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
        isError: true,
        timestamp: openedAt,
      } satisfies ToolResultMessage);
    }
    open.clear();
  };

  for (const message of messages) {
    if (message.role === "toolResult") {
      open.delete(message.toolCallId);
    } else {
      closeOpen();
    }
    closed.push(message);
    if (message.role === "assistant" && message.stopReason === "toolUse") {
      openedAt = message.timestamp;
      for (const block of message.content) {
        if (block.type === "toolCall") open.set(block.id, block.name);
      }
    }
  }
  closeOpen();
  return closed;
};

/** The model context of a pi-coding-agent session file's current branch. */
export const readLegacySession = (file: string): LegacySessionContext => {
  let summary: Message | undefined;
  const messages: Message[] = [];
  for (const message of SessionManager.open(file).buildSessionContext().messages) {
    const converted = convertToLlm([message]);
    if (message.role === "compactionSummary") {
      summary = converted[0];
    } else {
      // pi-durable renders its own system prompt.
      messages.push(...converted.filter((converted) => converted.role !== "system"));
    }
  }
  return { summary, messages: closeToolCalls(messages) };
};

const appendMessage = (tx: Tx, conversationId: ConversationId, message: Message) => {
  switch (message.role) {
    case "user":
      return tryDurablePromise(() =>
        tx.appendEntry(UserEntry, conversationId, { model: [message] }),
      );
    case "assistant":
      return tryDurablePromise(() =>
        tx.appendEntry(AssistantEntry, conversationId, { model: [message] }),
      );
    case "toolResult":
      return tryDurablePromise(() =>
        tx.appendEntry(ToolResultEntry, conversationId, {
          model: [message],
          data: { diagnostics: [] },
        }),
      );
    case "system":
      return Effect.void;
  }
};

/** Write a legacy session's model context into the root conversation of a new harness. */
export const importLegacySession = Effect.fn("importLegacySession")(function* (
  harness: Harness,
  file: string,
) {
  const legacy = yield* Effect.try({
    try: () => readLegacySession(file),
    catch: (cause) => new LegacySessionReadError({ file, cause }),
  });
  const root = yield* tryDurablePromise((context) => harness.root(context));
  const append = (tx: Tx) =>
    Effect.gen(function* () {
      if (legacy.summary !== undefined) {
        const summary = legacy.summary;
        yield* tryDurablePromise(() =>
          tx.appendEntry(ResetEntry, root.id, { head: "self", model: [summary] }),
        );
      }
      yield* Effect.forEach(legacy.messages, (message) => appendMessage(tx, root.id, message), {
        discard: true,
      });
    });
  // A commit is one atomic write; its callback must return a promise.
  const runPromise = Effect.runPromiseWith(yield* Effect.context());
  yield* tryDurablePromise((context) => root.commit((tx) => runPromise(append(tx)), context));
});

/** Remove what an import into `sessionFile` left behind if it stopped before the channel switched to its result. */
export const removeUnfinishedImport = Effect.fnUntraced(function* (sessionFile: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    [sessionFile, `${sessionFile}-wal`, `${sessionFile}-shm`],
    (file) => fs.remove(file, { force: true }),
    { discard: true },
  );
});
