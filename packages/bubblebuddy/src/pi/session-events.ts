import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  watchEvents,
  type AgentEvent,
  type CompactionResult,
  type ConversationId,
  type Harness,
  type SubmissionRecord,
  type TaskId,
  type TaskOutcome,
} from "@earendil-works/pi-durable";
import { type Cause, Effect, Fiber, Queue, Stream } from "effect";

import { type DurableError, tryDurablePromise } from "./durable.ts";

type AgentEventOf<Type extends AgentEvent["type"]> = Extract<AgentEvent, { type: Type }>;

/** pi-durable's agent events, with the outcomes their end events only point to. */
export type SessionEvent =
  | Exclude<AgentEvent, { type: "run_end" | "compaction_end" }>
  /** `settled`: the record of the run's first input; the commit that ends a run settles its inputs. */
  | (AgentEventOf<"run_end"> & { readonly settled: SubmissionRecord | undefined })
  | (AgentEventOf<"compaction_end"> & { readonly outcome: TaskOutcome<CompactionResult> });

export type SessionEventOf<Type extends SessionEvent["type"]> = Extract<
  SessionEvent,
  { type: Type }
>;

const toSessionEvents = (
  harness: Harness,
  events: readonly AgentEvent[],
): Effect.Effect<SessionEvent[], DurableError> =>
  Effect.forEach(events, (event): Effect.Effect<SessionEvent, DurableError> => {
    switch (event.type) {
      case "run_end":
        return Effect.succeed({
          ...event,
          settled: events.find(
            (other): other is AgentEventOf<"submission"> =>
              other.type === "submission" && other.record.id === event.inputs[0],
          )?.record,
        });
      case "compaction_end":
        return tryDurablePromise((context) =>
          // `compaction_end` names a compaction task.
          harness.waitForTask(event.taskId as TaskId<CompactionResult>, context),
        ).pipe(Effect.map(({ state }) => ({ ...event, outcome: state.outcome })));
      default:
        return Effect.succeed(event);
    }
  });

/** Hand a conversation's events, in commit order, to `handle` until the scope closes. */
export const watchSessionEvents = Effect.fnUntraced(function* (
  harness: Harness,
  conversationId: ConversationId,
  handle: (event: SessionEvent) => Effect.Effect<void>,
) {
  const batches = yield* Queue.unbounded<readonly AgentEvent[], Cause.Done>();
  const delivery = yield* Stream.fromQueue(batches).pipe(
    Stream.runForEach((events) =>
      toSessionEvents(harness, events).pipe(
        Effect.flatMap(Effect.forEach(handle, { discard: true })),
        Effect.ignore({ log: "Error", message: "Failed to deliver session events" }),
      ),
    ),
    Effect.forkScoped,
  );

  yield* Effect.acquireRelease(
    // The stream lives until it is stopped, not until the acquiring fiber ends.
    tryDurablePromise(() => watchEvents(harness, conversationId, BACKGROUND_CONTEXT)).pipe(
      Effect.tap((stream) =>
        Effect.sync(() =>
          stream.start((events) => Promise.resolve(void Queue.offerUnsafe(batches, events))),
        ),
      ),
    ),
    (stream) =>
      Effect.gen(function* () {
        // Stopping drops batches not handed over yet, which follow their commits in microtasks; a timer tick lets
        // them arrive. The delivery then finishes what was handed over.
        yield* Effect.sleep(0);
        yield* tryDurablePromise(() => stream.stop()).pipe(Effect.ignore);
        yield* Queue.end(batches);
        yield* Fiber.join(delivery).pipe(
          Effect.timeout("3 seconds"),
          Effect.ignore({ log: "Warn", message: "Timed out delivering session events" }),
        );
      }),
  );
});
