import { Effect, Result } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { assertInstanceOf, assertSuccess, assertTrue } from "@effect/vitest/utils";
import { HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { IncusApi } from "../src/incus-api.ts";
import { layerWith } from "./http-fixtures.ts";

describe("Incus HTTP adapter", () => {
  it.effect("only treats not found as absence, preserving other HTTP errors", () =>
    Effect.gen(function* () {
      const api = yield* IncusApi.Service;
      expect(yield* api.instances.exists("missing", { project: "default" })).toBe(false);
      const error = yield* api.instances
        .exists("unavailable", { project: "default" })
        .pipe(Effect.flip);
      assertInstanceOf(error, IncusApi.StatusCodeError);
      expect(error).toMatchObject({
        method: "GET",
        path: "/1.0/instances/unavailable?project=default",
        status: 503,
        body: "try later",
      });
    }).pipe(
      Effect.provide(
        layerWith((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("try later", { status: request.url.includes("missing") ? 404 : 503 }),
            ),
          ),
        ),
      ),
    ),
  );

  for (const malformed of [false, true]) {
    it.effect(
      `retains exec ownership in the caller scope with ${malformed ? "malformed" : "valid"} metadata`,
      () =>
        Effect.gen(function* () {
          const released: string[] = [];
          const api = yield* IncusApi.Service;
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const acquired = yield* api.instances
                .exec("container", { command: ["true"] }, { project: "default" }, (operation) =>
                  Effect.sync(() => {
                    released.push(operation.id);
                  }),
                )
                .pipe(Effect.result);
              expect(released).toEqual([]);
              return acquired;
            }),
          );
          if (malformed) {
            assertTrue(Result.isFailure(result));
            assertInstanceOf(result.failure, HttpClientError.HttpClientError);
            assertInstanceOf(result.failure.reason, HttpClientError.DecodeError);
          } else {
            assertSuccess(result, { id: "owned" });
          }
          expect(released).toEqual(["owned"]);
        }).pipe(
          Effect.provide(
            layerWith((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    malformed
                      ? "{"
                      : JSON.stringify({
                          type: "async",
                          operation: "/1.0/operations/owned",
                          metadata: { id: "owned", metadata: {} },
                        }),
                    { status: 202, headers: { location: "/1.0/operations/owned" } },
                  ),
                ),
              ),
            ),
          ),
        ),
    );
  }
});
