import type { Scope } from "effect";
import { Effect, Option, TxQueue, TxRef } from "effect";

export interface PriorityDrainableWorker<A> {
  readonly enqueueHigh: (item: A) => Effect.Effect<void>;
  readonly enqueueLow: (item: A) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

export const makePriorityDrainableWorker = <A, R>(
  process: (item: A) => Effect.Effect<void, never, R>,
): Effect.Effect<PriorityDrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const high = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const low = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    const takeNext = Effect.gen(function* () {
      const maybeHigh = yield* TxQueue.poll(high);
      if (Option.isSome(maybeHigh)) {
        return maybeHigh.value;
      }

      const maybeLow = yield* TxQueue.poll(low);
      if (Option.isSome(maybeLow)) {
        return maybeLow.value;
      }

      return yield* Effect.txRetry;
    }).pipe(Effect.tx);

    yield* takeNext.pipe(
      Effect.tap((item) =>
        Effect.ensuring(
          process(item),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueueHigh = (item: A): Effect.Effect<void> =>
      TxQueue.offer(high, item).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    const enqueueLow = (item: A): Effect.Effect<void> =>
      TxQueue.offer(low, item).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    const drain = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    return { enqueueHigh, enqueueLow, drain } satisfies PriorityDrainableWorker<A>;
  });
