import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import {
  IncusApi,
  IncusApiOperationError,
  IncusApiTimeoutError,
  type IncusApiService,
} from "../src/api.ts";
import { IncusOperationAbortError, IncusOperations } from "../src/operations.ts";

const makeApi = (overrides: Partial<IncusApiService["operations"]>): IncusApiService => ({
  instances: {
    create: () => Effect.die("unexpected"),
    exists: () => Effect.die("unexpected"),
    delete: () => Effect.die("unexpected"),
    setState: () => Effect.die("unexpected"),
    exec: () => Effect.die("unexpected"),
    files: {
      readBytes: () => Effect.die("unexpected"),
      readText: () => Effect.die("unexpected"),
      stat: () => Effect.die("unexpected"),
      write: () => Effect.die("unexpected"),
      readExecOutput: () => Effect.die("unexpected"),
    },
  },
  operations: {
    wait: () => Effect.never,
    cancel: () => Effect.void,
    ...overrides,
  },
});

const layer = (api: IncusApiService) =>
  IncusOperations.layer.pipe(Layer.provide(Layer.succeed(IncusApi, api)));

const extractError = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (exit._tag !== "Failure") return undefined;
  const option = Cause.findErrorOption(exit.cause);
  return Option.isSome(option) ? option.value : undefined;
};

describe("IncusOperations", () => {
  it.effect("cancels the Incus operation when an AbortSignal aborts a wait", () => {
    const controller = new AbortController();
    let canceled = false;
    const api = makeApi({
      cancel: () =>
        Effect.sync(() => {
          canceled = true;
        }),
    });

    return Effect.gen(function* () {
      const operations = yield* IncusOperations;
      const fiber = yield* Effect.forkChild(
        operations.waitInterruptible("op-123", {
          project: "default",
          signal: controller.signal,
        }),
      );

      controller.abort("test abort");
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      const error = extractError(exit);

      assert.strictEqual(exit._tag, "Failure");
      assert.instanceOf(error, IncusOperationAbortError);
      assert.strictEqual(canceled, true);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("times out waits using the configured grace", () => {
    const api = makeApi({});

    return Effect.gen(function* () {
      const operations = yield* IncusOperations;
      const fiber = yield* Effect.forkChild(
        operations.wait("op-123", { project: "default", timeoutMs: 50 }),
      );
      yield* TestClock.adjust(5_100);
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);

      assert.strictEqual(exit._tag, "Failure");
      const error = extractError(exit);
      assert.instanceOf(error, IncusApiTimeoutError);
      if (error instanceof IncusApiTimeoutError) {
        assert.strictEqual(error.requestedTimeoutMs, 50);
        assert.strictEqual(error.clientTimeoutMs, 5_050);
      }
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("preserves AbortSignal reason on abort errors", () => {
    const reason = new Error("stop");
    const controller = new AbortController();
    controller.abort(reason);

    return Effect.gen(function* () {
      const operations = yield* IncusOperations;
      const exit = yield* Effect.exit(
        operations.waitInterruptible("op-123", {
          project: "default",
          signal: controller.signal,
        }),
      );
      const error = extractError(exit);

      assert.instanceOf(error, IncusOperationAbortError);
      if (error instanceof IncusOperationAbortError) {
        assert.strictEqual(error.reason, reason);
      }
    }).pipe(Effect.provide(layer(makeApi({}))));
  });

  it.effect("cancels an interruptible wait when the client-side timeout fires", () => {
    let canceled = false;
    const api = makeApi({
      cancel: () =>
        Effect.sync(() => {
          canceled = true;
        }),
    });

    return Effect.gen(function* () {
      const operations = yield* IncusOperations;
      const fiber = yield* Effect.forkChild(
        operations.waitInterruptible("op-123", { project: "default", timeoutMs: 50 }),
      );
      yield* TestClock.adjust(5_100);
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);

      assert.strictEqual(exit._tag, "Failure");
      assert.instanceOf(extractError(exit), IncusApiTimeoutError);
      assert.strictEqual(canceled, true);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("does not cancel an operation after a regular Incus operation failure", () => {
    let canceled = false;
    const api = makeApi({
      wait: () =>
        Effect.fail(
          new IncusApiOperationError({
            operation: "op-123",
            message: "boom",
            metadata: {},
          }),
        ),
      cancel: () =>
        Effect.sync(() => {
          canceled = true;
        }),
    });

    return Effect.gen(function* () {
      const operations = yield* IncusOperations;
      const exit = yield* Effect.exit(
        operations.waitInterruptible("op-123", { project: "default" }),
      );

      assert.strictEqual(exit._tag, "Failure");
      assert.instanceOf(extractError(exit), IncusApiOperationError);
      assert.strictEqual(canceled, false);
    }).pipe(Effect.provide(layer(api)));
  });
});
