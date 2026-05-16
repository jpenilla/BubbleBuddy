import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { IncusApi, IncusApiTimeoutError, type IncusApiService } from "../src/api.ts";
import { IncusOperations } from "../src/operations.ts";

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
  it.effect("returns running wait results without treating them as timeouts", () => {
    const api = makeApi({
      wait: () => Effect.succeed({ status: "running", metadata: { progress: "still going" } }),
    });

    return Effect.gen(function* () {
      const operations = yield* IncusOperations;
      const result = yield* operations.wait("op-123", { project: "default", timeoutSeconds: 1 });

      assert.deepStrictEqual(result, {
        status: "running",
        metadata: { progress: "still going" },
      });
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("times out waits using the configured grace", () => {
    const api = makeApi({});

    return Effect.gen(function* () {
      const operations = yield* IncusOperations;
      const fiber = yield* Effect.forkChild(
        operations.wait("op-123", { project: "default", timeoutSeconds: 1 }),
      );
      yield* TestClock.adjust("6 seconds");
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);

      assert.strictEqual(exit._tag, "Failure");
      const error = extractError(exit);
      assert.instanceOf(error, IncusApiTimeoutError);
      if (error instanceof IncusApiTimeoutError) {
        assert.strictEqual(error.requestedTimeoutSeconds, 1);
        assert.strictEqual(error.clientTimeoutSeconds, 6);
      }
    }).pipe(Effect.provide(layer(api)));
  });
});
