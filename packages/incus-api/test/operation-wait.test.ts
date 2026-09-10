import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { assertInstanceOf } from "@effect/vitest/utils";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { TestClock } from "effect/testing";

import { IncusApi } from "../src/incus-api.ts";
import { errorFrom } from "./incus-fixtures.ts";
import { type HttpHandler, layerWith } from "./http-fixtures.ts";

const response = (request: HttpClientRequest.HttpClientRequest, metadata: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify({ type: "sync", metadata }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

describe("Incus operation waits", () => {
  it.effect("reports failed operations and preserves requested failure metadata", () =>
    Effect.gen(function* () {
      const api = yield* IncusApi.Service;
      const failed = yield* api.operations
        .wait("operation-failed", { project: "default" })
        .pipe(Effect.exit);
      const returned = yield* api.operations.wait("operation-returned", {
        project: "default",
        failureMode: "return",
      });

      const error = errorFrom(failed);
      expect(error).toBeInstanceOf(IncusApi.OperationError);
      if (error instanceof IncusApi.OperationError) {
        expect(error.operation).toBe("operation-failed");
        expect(error.message).toBe("command failed");
      }
      expect(returned).toEqual(
        IncusApi.OperationWaitResult.Failure({
          error: "command failed",
          metadata: { return: 127 },
        }),
      );
    }).pipe(
      Effect.provide(
        layerWith((request) =>
          Effect.succeed(
            response(request, {
              status_code: 400,
              err: "command failed",
              metadata: { return: 127 },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("returns an in-progress operation without treating it as a failure", () =>
    Effect.gen(function* () {
      const api = yield* IncusApi.Service;
      const result = yield* api.operations.wait("operation-running", { project: "default" });

      expect(result).toEqual(
        IncusApi.OperationWaitResult.Running({ metadata: { progress: "copying" } }),
      );
    }).pipe(
      Effect.provide(
        layerWith((request) =>
          Effect.succeed(
            response(request, { status_code: 103, metadata: { progress: "copying" } }),
          ),
        ),
      ),
    ),
  );

  it.effect("times out a stalled request and interrupts the HTTP work", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const handler: HttpHandler = (request) => {
        expect(new URL(request.url, "http://incus").searchParams.get("timeout")).toBe("1");
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
      };
      return yield* Effect.gen(function* () {
        const api = yield* IncusApi.Service;
        const fiber = yield* api.operations
          .wait("operation-stalled", { project: "default", timeoutSeconds: 1 })
          .pipe(Effect.flip, Effect.forkChild);

        yield* Deferred.await(started);
        yield* TestClock.adjust("1 second");
        expect(yield* Deferred.isDone(interrupted)).toBe(false);
        yield* TestClock.adjust("1 minute");
        const error = yield* Fiber.join(fiber);
        assertInstanceOf(error, IncusApi.TimeoutError);
        expect(error.requestedTimeoutSeconds).toBe(1);
        expect(error.path).toContain("operation-stalled");
        yield* Deferred.await(interrupted);
      }).pipe(Effect.provide(layerWith(handler)));
    }),
  );
});
