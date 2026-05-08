import { describe, expect, test } from "vitest";
import { Deferred, Effect } from "effect";

import { makePriorityDrainableWorker } from "../src/shared/priority-drainable-worker.ts";

const runEffect = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

describe("makePriorityDrainableWorker", () => {
  test("processes high priority work before low priority work", async () => {
    await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const processed: string[] = [];
          const worker = yield* makePriorityDrainableWorker((item: string) =>
            Effect.sync(() => {
              processed.push(item);
            }),
          );

          yield* worker.enqueueLow("low");
          yield* worker.enqueueHigh("high");
          yield* worker.drain;

          expect(processed).toEqual(["high", "low"]);
        }),
      ),
    );
  });

  test("waits for low priority work enqueued during active high priority processing before draining", async () => {
    await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const processed: string[] = [];
          const highStarted = yield* Deferred.make<void>();
          const releaseHigh = yield* Deferred.make<void>();
          const lowStarted = yield* Deferred.make<void>();
          const releaseLow = yield* Deferred.make<void>();

          const worker = yield* makePriorityDrainableWorker((item: string) =>
            Effect.gen(function* () {
              if (item === "high") {
                yield* Deferred.succeed(highStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseHigh);
              }

              if (item === "low") {
                yield* Deferred.succeed(lowStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseLow);
              }

              processed.push(item);
            }),
          );

          yield* worker.enqueueHigh("high");
          yield* Deferred.await(highStarted);

          const drained = yield* Deferred.make<void>();
          yield* Effect.forkChild(
            worker.drain.pipe(
              Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
            ),
          );

          yield* worker.enqueueLow("low");
          yield* Deferred.succeed(releaseHigh, undefined).pipe(Effect.orDie);
          yield* Deferred.await(lowStarted);

          expect(yield* Deferred.isDone(drained)).toBe(false);

          yield* Deferred.succeed(releaseLow, undefined).pipe(Effect.orDie);
          yield* Deferred.await(drained);

          expect(processed).toEqual(["high", "low"]);
        }),
      ),
    );
  });

  test("waits for high priority work enqueued during active low priority processing before draining", async () => {
    await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const processed: string[] = [];
          const lowStarted = yield* Deferred.make<void>();
          const releaseLow = yield* Deferred.make<void>();
          const highStarted = yield* Deferred.make<void>();
          const releaseHigh = yield* Deferred.make<void>();

          const worker = yield* makePriorityDrainableWorker((item: string) =>
            Effect.gen(function* () {
              if (item === "low") {
                yield* Deferred.succeed(lowStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseLow);
              }

              if (item === "high") {
                yield* Deferred.succeed(highStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseHigh);
              }

              processed.push(item);
            }),
          );

          yield* worker.enqueueLow("low");
          yield* Deferred.await(lowStarted);

          const drained = yield* Deferred.make<void>();
          yield* Effect.forkChild(
            worker.drain.pipe(
              Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
            ),
          );

          yield* worker.enqueueHigh("high");
          yield* Deferred.succeed(releaseLow, undefined).pipe(Effect.orDie);
          yield* Deferred.await(highStarted);

          expect(yield* Deferred.isDone(drained)).toBe(false);

          yield* Deferred.succeed(releaseHigh, undefined).pipe(Effect.orDie);
          yield* Deferred.await(drained);

          expect(processed).toEqual(["low", "high"]);
        }),
      ),
    );
  });
});
