import { createHash } from "node:crypto";

import { type Draft } from "@earendil-works/chord";
import {
  type CompactionResult,
  type Conversation,
  type ConversationView,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Page,
  type TaskId,
} from "@earendil-works/pi-durable";
import { type GuildTextBasedChannel } from "discord.js";
import { Cause, Effect, FiberMap, FiberSet, type Scope, Semaphore } from "effect";

import { type DurableError, tryDurablePromise } from "../../pi/durable.ts";
import { Posting } from "../posting.ts";
import { createTypingIndicator } from "../typing-indicator.ts";
import { editMessage, sendChunkedMessage, sendMessage } from "../utils.ts";
import { attach, reduce, reduceEntries, settleCompaction } from "./reduce.ts";
import { render } from "./render.ts";
import {
  FeedDoc,
  type FeedState,
  isCard,
  isPending,
  type Item,
  liveState,
  markShown,
  prune,
} from "./state.ts";

interface MakeInput {
  readonly channel: GuildTextBasedChannel;
  readonly showThinking: Effect.Effect<boolean>;
  /** Tells this session's Discord nonces apart from other sessions' in the channel. */
  readonly sessionName: string;
}

interface ShowInput {
  readonly harness: Harness;
  readonly conversation: Conversation;
}

export interface Interface {
  readonly executeOrdered: Posting.ExecuteOrdered;
  /**
   * Shows `conversation` in the channel for the rest of the scope, resuming from the stored projection. A feed shows
   * one conversation at a time.
   */
  readonly show: (input: ShowInput) => Effect.Effect<void, DurableError, Scope.Scope>;
}

const NONCE_LENGTH = 25;
const ENTRY_PAGE_SIZE = 100;

/** A post's Discord nonce: a post repeated after a crash between posting and recording it returns the first one. */
const nonceFor = (session: string, key: string, part: number) =>
  createHash("sha256")
    .update(`${session}\0${key}\0${part}`)
    .digest("base64url")
    .slice(0, NONCE_LENGTH);

/** Replaces the stored document with `state`: a document is only written through its draft. */
const writeState = (doc: Draft<FeedState>, state: FeedState) => {
  for (const key of Object.keys(doc)) {
    if (!Object.hasOwn(state, key)) Reflect.deleteProperty(doc, key);
  }
  Object.assign(doc, state);
};

/** Whether the model is writing an answer's text, as opposed to thinking or calling tools. */
const isWritingAnswer = (view: ConversationView): boolean => {
  const last = liveState(view)?.generation?.message?.content.at(-1);
  return last?.type === "text" && last.text.length > 0;
};

/** The transcript's entries after `cursor`, up to `last` if given. */
const entriesAfter = Effect.fnUntraced(function* (
  conversation: Conversation,
  cursor: EntryId | undefined,
  last?: EntryId,
) {
  const entries: EntryRecord[] = [];
  let page: Page<EntryRecord, Cursor> | undefined;
  do {
    const next = page?.next;
    page = yield* tryDurablePromise((context) =>
      conversation.entries(
        {
          ...(cursor === undefined ? {} : { minEntryId: cursor }),
          ...(last === undefined ? {} : { maxEntryId: last }),
          order: "ascending",
        },
        ENTRY_PAGE_SIZE,
        next,
        context,
      ),
    );
    entries.push(...page.items.filter(({ id }) => cursor === undefined || id > cursor));
  } while (page.next !== undefined);
  return entries;
});

/** The entries after `cursor` that a view's window starts after. */
const missedEntries = (
  conversation: Conversation,
  cursor: EntryId | undefined,
  view: ConversationView,
) =>
  view.before === undefined || (cursor !== undefined && view.before <= cursor)
    ? Effect.succeed([])
    : entriesAfter(conversation, cursor, view.before);

/**
 * Posts or edits an item's message. Returns the message a card is shown in, and whether it is `current`: shows the
 * item's revision. `unrecorded` holds the cards that may be in the channel without their message recorded; posting
 * one may return that earlier message, with an older revision.
 */
const showItem = Effect.fnUntraced(function* (
  channel: GuildTextBasedChannel,
  sessionName: string,
  item: Item,
  unrecorded: Set<string>,
) {
  const rendering = render(item.view);
  const nonce = (part: number) => ({
    nonce: nonceFor(sessionName, item.key, part),
    enforceNonce: true,
  });
  if (rendering.type === "posts") {
    for (const [part, post] of rendering.posts.entries()) {
      yield* sendMessage(channel, { ...post, ...nonce(part) });
    }
    return { message: undefined, current: true };
  }
  if (item.message !== undefined) {
    yield* editMessage(channel, item.message, rendering.edit);
    return { message: item.message, current: true };
  }
  const mayBePosted = unrecorded.has(item.key);
  unrecorded.add(item.key);
  const message = yield* sendMessage(channel, { ...rendering.post, ...nonce(0) });
  return { message, current: !mayBePosted };
});

/** The channel's feed: one lane for everything posted to the channel, the conversation's output and tools' posts. */
export const make = Effect.fnUntraced(function* (input: MakeInput) {
  const { channel } = input;
  const posting = Posting.Service.of({
    send: (options) => Effect.asVoid(sendMessage(channel, options)),
    sendChunked: (options) => sendChunkedMessage(channel, options),
  });
  const lane = yield* Semaphore.make(1);
  /** Brings the channel up to the shown conversation; nothing before one is shown. */
  let catchUp: Effect.Effect<void> = Effect.void;

  const executeOrdered: Posting.ExecuteOrdered = (operation) =>
    lane
      .withPermit(
        Effect.andThen(
          Effect.suspend(() => catchUp),
          Effect.provideService(operation, Posting.Service, posting),
        ),
      )
      .pipe(Effect.withSpan("ChannelFeed.executeOrdered"));

  const show = Effect.fn("ChannelFeed.show")(
    function* ({ harness, conversation }: ShowInput) {
      const typing = yield* createTypingIndicator({ channel });
      const passes = yield* FiberSet.make<void>();
      /** Outcome lookups of compactions that left `pi.live`, one per task. */
      const lookups = yield* FiberMap.make<TaskId<CompactionResult>>();
      /** Runs the watch's deliveries; created before the watch, so they are interrupted after it is released. */
      const deliver = yield* FiberSet.makeRuntimePromise<never, void, never>();

      const stored = yield* tryDurablePromise((context) =>
        harness.snapshot(FeedDoc, conversation.id, context),
      );
      let state: FeedState = stored ?? { items: [] };
      let persisted: FeedState | undefined = stored;
      /**
       * Cards that may be in the channel without their message recorded: stored without one, or whose post failed or
       * was cut off.
       */
      const unrecorded = new Set(
        state.items
          .filter((item) => item.message === undefined && isCard(item.view))
          .map((item) => item.key),
      );
      let passQueued = false;

      // Runs after the final pass: until then, tools' posts still wait for the channel to catch up.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          catchUp = Effect.void;
        }),
      );

      const persist = Effect.gen(function* () {
        state = prune(state);
        const snapshot = state;
        if (snapshot === persisted) return;
        yield* tryDurablePromise((context) =>
          conversation.commit(
            async (tx) => writeState(await tx.doc(FeedDoc, conversation.id), snapshot),
            context,
          ),
        );
        persisted = snapshot;
      });

      /** Brings Discord up to the current state, item by item in channel order, then stores it. */
      const pass = Effect.gen(function* () {
        passQueued = false;
        let item = state.items.find(isPending);
        while (item !== undefined) {
          const shown = item;
          // A failed item is not retried: later items must not wait on it.
          const { message, current } = yield* showItem(
            channel,
            input.sessionName,
            shown,
            unrecorded,
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logError("Failed to show channel feed item", cause).pipe(
                    Effect.annotateLogs({ feedItem: shown.key }),
                    Effect.as({ message: shown.message, current: true }),
                  ),
            ),
          );
          // Not current: the post may have returned an earlier message, so the item stays pending and is edited next.
          state = markShown(state, shown.key, current ? shown.revision : shown.shown, message);
          if (message !== undefined) unrecorded.delete(shown.key);
          item = state.items.find(isPending);
        }
      }).pipe(
        // Interrupted too: what it showed is not posted again.
        Effect.ensuring(
          persist.pipe(
            Effect.catch((error) => Effect.logError("Failed to store channel feed", error)),
          ),
        ),
        Effect.withSpan("ChannelFeed.pass"),
      );
      const passInLane = lane.withPermit(pass);

      const schedulePass = Effect.suspend(() => {
        if (passQueued) return Effect.void;
        passQueued = true;
        return FiberSet.run(passes, passInLane).pipe(Effect.asVoid);
      });

      const settle = (taskId: TaskId<CompactionResult>) =>
        // Reads the stored outcome: `waitForTask` would start the harness's tasks.
        tryDurablePromise((context) => harness.getTask(taskId, context)).pipe(
          // A compaction leaves `pi.live` in the commit that ends its task.
          Effect.map((task) =>
            task?.state.status === "terminal" ? task.state.outcome : undefined,
          ),
          Effect.tap((outcome) => {
            if (outcome === undefined) return Effect.logError("Compaction has no outcome");
            return outcome.status === "completed" || outcome.status === "aborted"
              ? Effect.void
              : Effect.logError("Compaction failed").pipe(Effect.annotateLogs({ outcome }));
          }),
          Effect.catch((error) =>
            Effect.logError("Failed to read how a compaction ended", error).pipe(
              Effect.as(undefined),
            ),
          ),
          Effect.flatMap((outcome) =>
            Effect.suspend(() => {
              state = settleCompaction(state, taskId, outcome);
              return changed;
            }),
          ),
        );

      /** Schedules what a state change needs: a pass, and the outcomes of compactions that left `pi.live`. */
      const changed: Effect.Effect<void> = Effect.gen(function* () {
        if (state !== persisted) yield* schedulePass;
        for (const { view } of state.items) {
          if (view.type !== "compaction" || view.status.phase !== "settling") continue;
          yield* FiberMap.run(lookups, view.taskId, settle(view.taskId), { onlyIfMissing: true });
        }
      });

      const project = Effect.fn("ChannelFeed.project")(
        function* (view: ConversationView) {
          const missed = yield* missedEntries(conversation, state.cursor, view);
          const showThinking = yield* input.showThinking;
          state = reduce(
            state,
            missed.length === 0 ? view : { ...view, entries: [...missed, ...view.entries] },
            { showThinking },
          );
          yield* isWritingAnswer(view) ? typing.activate : typing.deactivate;
          yield* changed;
        },
        Effect.catchCause((cause) =>
          Effect.logError("Failed to project conversation to the channel", cause),
        ),
      );

      /** The conversation as it is now, which the watch may not have delivered yet. */
      const currentView = tryDurablePromise(async (context) => {
        const current = await conversation.watch(context);
        await current.stop();
        return current.value;
      });

      // Runs after the watch's release: the final pass shows everything committed until then.
      yield* Effect.addFinalizer(() =>
        passInLane.pipe(
          Effect.timeout("3 seconds"),
          Effect.ignore({ log: "Warn", message: "Timed out showing the channel feed" }),
        ),
      );
      let delivering: Promise<void> = Promise.resolve();
      const watch = yield* Effect.acquireRelease(
        tryDurablePromise((context) =>
          conversation.watch(
            context,
            // Inclusive: the cursor's entry comes again, and is skipped as projected.
            stored?.cursor === undefined ? undefined : { from: stored.cursor },
          ),
        ),
        (watch) =>
          // Stopping drops undelivered changes and leaves a running call running: wait for it, then catch up.
          tryDurablePromise(async () => {
            await watch.stop();
            await delivering;
          }).pipe(
            Effect.andThen(currentView),
            Effect.flatMap(project),
            Effect.ignore({ log: "Warn", message: "Failed to stop watching the conversation" }),
          ),
      );
      if (stored === undefined) state = attach(watch.value);

      yield* project(watch.value);
      // What the last run stored without showing, such as when its final pass timed out.
      if (state.items.some(isPending)) yield* schedulePass;
      watch.start((call) => {
        delivering = deliver(
          call.kind === "value"
            ? project(call.value)
            : Effect.logWarning("Conversation watch failed", call.error),
        );
        return delivering;
      });

      // A tool's call is committed before the tool runs: the transcript holds everything before it. Only entries
      // apply here; the live state comes through the watch, in order.
      const projectEntries = Effect.gen(function* () {
        const entries = yield* entriesAfter(conversation, state.cursor);
        const showThinking = yield* input.showThinking;
        state = reduceEntries(state, entries, { showThinking });
      }).pipe(
        Effect.catch((error) => Effect.logError("Failed to read the conversation", error)),
        Effect.withSpan("ChannelFeed.projectEntries"),
      );
      // Interrupted with its tool: what it did not show goes out after the tool.
      catchUp = Effect.andThen(projectEntries, pass).pipe(Effect.onInterrupt(() => schedulePass));
    },
    Effect.annotateLogs({ component: "ChannelFeed" }),
  );

  const feed: Interface = { executeOrdered, show };
  return feed;
});

export * as ChannelFeed from "./channel-feed.ts";
