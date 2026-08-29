import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";

import { makePriorityDrainableWorker } from "../src/shared/priority-drainable-worker.ts";

const makeGate = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  return { started, release };
});

describe("makePriorityDrainableWorker", () => {
  it.effect("processes high priority work before low priority work", () =>
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

  for (const testCase of [
    { active: "high", queued: "low" },
    { active: "low", queued: "high" },
  ] as const) {
    it.effect(
      `waits for ${testCase.queued} priority work enqueued during active ${testCase.active} priority processing`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const processed: string[] = [];
            const active = yield* makeGate;
            const queued = yield* makeGate;
            const gates = { [testCase.active]: active, [testCase.queued]: queued };
            const worker = yield* makePriorityDrainableWorker((item: "high" | "low") =>
              Effect.gen(function* () {
                const gate = gates[item];
                yield* Deferred.succeed(gate.started, undefined).pipe(Effect.orDie);
                yield* Deferred.await(gate.release);
                processed.push(item);
              }),
            );
            const enqueue = {
              high: worker.enqueueHigh,
              low: worker.enqueueLow,
            };

            yield* enqueue[testCase.active](testCase.active);
            yield* Deferred.await(active.started);

            const drained = yield* Deferred.make<void>();
            yield* Effect.forkChild(
              worker.drain.pipe(
                Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
              ),
            );

            yield* enqueue[testCase.queued](testCase.queued);
            yield* Deferred.succeed(active.release, undefined).pipe(Effect.orDie);
            yield* Deferred.await(queued.started);
            expect(yield* Deferred.isDone(drained)).toBe(false);

            yield* Deferred.succeed(queued.release, undefined).pipe(Effect.orDie);
            yield* Deferred.await(drained);
            expect(processed).toEqual([testCase.active, testCase.queued]);
          }),
        ),
    );
  }
});
