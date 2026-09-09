import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "@effect/vitest";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { TestClock } from "effect/testing";

import { IncusApi } from "../src/incus-api.ts";
import { IncusTransport } from "../src/incus-transport.ts";
import { errorFrom } from "./incus-fixtures.ts";

type HttpHandler = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const httpClient = (handler: HttpHandler): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(Effect.flatMap(handler), Effect.succeed);

const layerWith = (handler: HttpHandler) =>
  IncusApi.layer.pipe(
    Layer.provide(
      Layer.succeed(IncusTransport.Service, {
        httpClient: httpClient(handler),
        makeWebSocket: () => Effect.die(new Error("Unexpected websocket request")),
      }),
    ),
  );

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
      expect(returned).toEqual({
        status: "failure",
        error: "command failed",
        metadata: { return: 127 },
      });
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

      expect(result).toEqual({ status: "running", metadata: { progress: "copying" } });
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
      const handler: HttpHandler = () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
      return yield* Effect.gen(function* () {
        const api = yield* IncusApi.Service;
        const fiber = yield* api.operations
          .wait("operation-stalled", { project: "default", timeoutSeconds: 1 })
          .pipe(Effect.forkChild);

        yield* Deferred.await(started);
        yield* TestClock.adjust("1 minute");
        const exit = yield* Fiber.await(fiber);

        const error = errorFrom(exit);
        expect(error).toBeInstanceOf(IncusApi.TimeoutError);
        if (error instanceof IncusApi.TimeoutError) {
          expect(error.requestedTimeoutSeconds).toBe(1);
          expect(error.path).toContain("operation-stalled");
        }
        yield* Deferred.await(interrupted);
      }).pipe(Effect.provide(layerWith(handler)));
    }),
  );
});
