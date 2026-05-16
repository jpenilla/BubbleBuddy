import { Cause, Effect, Exit, Layer, Option } from "effect";
import { assert, describe, it } from "@effect/vitest";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { IncusApi, IncusApiOperationError, IncusApiStatusCodeError } from "../src/api.ts";
import { IncusHttpClient } from "../src/http-client.ts";

const layerWithHttp = (client: HttpClient.HttpClient) =>
  IncusApi.layer.pipe(Layer.provide(Layer.succeed(IncusHttpClient, client)));

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(Effect.flatMap(handler), Effect.succeed);

const extractError = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (exit._tag !== "Failure") return undefined;
  const option = Cause.findErrorOption(exit.cause);
  return Option.isSome(option) ? option.value : undefined;
};

describe("IncusApi error paths", () => {
  it.effect("raises HttpClientError on execute failure", () => {
    const http = makeHttpClient(() =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: HttpClientRequest.get("http://test"),
            cause: new Error("network down"),
          }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const api = yield* IncusApi;
      const exit = yield* Effect.exit(api.instances.exists("test", { project: "default" }));
      assert.strictEqual(exit._tag, "Failure");
      assert.instanceOf(extractError(exit), HttpClientError.HttpClientError);
    }).pipe(Effect.provide(layerWithHttp(http)));
  });

  it.effect("raises IncusApiStatusCodeError on non-2xx status", () => {
    const http = makeHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("server error", { status: 500 })),
      ),
    );

    return Effect.gen(function* () {
      const api = yield* IncusApi;
      const exit = yield* Effect.exit(api.instances.exists("test", { project: "default" }));
      assert.strictEqual(exit._tag, "Failure");
      const error = extractError(exit);
      assert.instanceOf(error, IncusApiStatusCodeError);
      if (error instanceof IncusApiStatusCodeError) {
        assert.strictEqual(error.status, 500);
      }
    }).pipe(Effect.provide(layerWithHttp(http)));
  });

  it.effect("raises HttpClientError on malformed JSON body", () => {
    const http = makeHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const api = yield* IncusApi;
      const exit = yield* Effect.exit(api.instances.create({}, { project: "default" }));
      assert.strictEqual(exit._tag, "Failure");
      assert.instanceOf(extractError(exit), HttpClientError.HttpClientError);
    }).pipe(Effect.provide(layerWithHttp(http)));
  });

  it.effect("raises IncusApiOperationError when operation metadata has status_code >= 400", () => {
    const http = makeHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({ type: "sync", metadata: { status_code: 500, err: "boom" } }),
            {
              status: 200,
            },
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const api = yield* IncusApi;
      const exit = yield* Effect.exit(api.operations.wait("op-123", { project: "default" }));
      assert.strictEqual(exit._tag, "Failure");
      const error = extractError(exit);
      assert.instanceOf(error, IncusApiOperationError);
      if (error instanceof IncusApiOperationError) {
        assert.strictEqual(error.message, "boom");
        assert.deepStrictEqual(error.metadata, {
          type: "sync",
          metadata: { status_code: 500, err: "boom" },
        });
      }
    }).pipe(Effect.provide(layerWithHttp(http)));
  });

  it.effect("operations.wait preserves failed exec metadata when requested", () => {
    const http = makeHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              type: "sync",
              metadata: {
                status_code: 400,
                err: "Command not found",
                metadata: { return: 127 },
              },
            }),
            {
              status: 200,
            },
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const api = yield* IncusApi;
      const result = yield* api.operations.wait("op-123", {
        project: "default",
        failureMode: "return",
      });
      assert.deepStrictEqual(result, {
        status: "failure",
        error: "Command not found",
        metadata: { return: 127 },
      });
    }).pipe(Effect.provide(layerWithHttp(http)));
  });

  it.effect("instances.exec decodes websocket fd secrets into named fields", () => {
    const http = makeHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              type: "async",
              operation: "/1.0/operations/op-123",
              metadata: {
                metadata: {
                  fds: {
                    "0": "stdin-secret",
                    "1": "stdout-secret",
                    "2": "stderr-secret",
                    control: "control-secret",
                  },
                },
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const api = yield* IncusApi;
      const operation = yield* api.instances.exec(
        "test",
        { command: ["true"] },
        {
          project: "default",
        },
      );
      assert.deepStrictEqual(operation, {
        id: "op-123",
        fds: {
          stdin: "stdin-secret",
          stdout: "stdout-secret",
          stderr: "stderr-secret",
          control: "control-secret",
        },
      });
    }).pipe(Effect.provide(layerWithHttp(http)));
  });

  it.effect("instances.exists returns false on 404", () => {
    const http = makeHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 })),
      ),
    );

    return Effect.gen(function* () {
      const api = yield* IncusApi;
      const result = yield* api.instances.exists("missing", { project: "default" });
      assert.strictEqual(result, false);
    }).pipe(Effect.provide(layerWithHttp(http)));
  });
});
