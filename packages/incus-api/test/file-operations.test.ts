import { Context, Effect, Layer, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { IncusFileOperations } from "../src/incus-file-operations.ts";
import { IncusApi } from "../src/transport/incus-api.ts";
import { apiFixture, errorFrom } from "./incus-fixtures.ts";

class StreamValue extends Context.Service<
  StreamValue,
  { readonly chunks: ReadonlyArray<Uint8Array> }
>()("incus-api-test/StreamValue") {}

class SourceFailure extends Schema.TaggedError<SourceFailure>()(
  "incus-api-test/SourceFailure",
  {},
) {}

describe("Incus file writes", () => {
  it.effect("consumes caller-provided streamed content with its required service", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
      const api = apiFixture({
        write: (_name, _path, body) =>
          body === undefined
            ? Effect.void
            : body.pipe(
                Stream.runCollect,
                Effect.updateContext<never, never>(Context.omit(StreamValue)),
                Effect.mapError(
                  () =>
                    new IncusApi.StatusCodeError({
                      method: "POST",
                      path: "/files",
                      status: 500,
                      body: "stream failed",
                    }),
                ),
                Effect.flatMap((chunks) => Ref.set(received, Array.from(chunks))),
                Effect.asVoid,
              ),
      });
      const source = Stream.unwrap(
        Effect.map(StreamValue, ({ chunks }) => Stream.fromIterable(chunks)),
      );

      yield* IncusFileOperations.create(api, "container", "default")
        .write("/tmp/message.txt", source)
        .pipe(
          Effect.provide(
            Layer.succeed(StreamValue, {
              chunks: [new Uint8Array([0, 1, 2]), new Uint8Array([127, 128, 255])],
            }),
          ),
        );

      expect(Uint8Array.from((yield* Ref.get(received)).flatMap((chunk) => [...chunk]))).toEqual(
        new Uint8Array([0, 1, 2, 127, 128, 255]),
      );
    }),
  );

  it.effect("preserves a source stream failure when sending it fails", () =>
    Effect.gen(function* () {
      const sourceFailure = new SourceFailure();
      const transportFailure = new IncusApi.StatusCodeError({
        method: "POST",
        path: "/files",
        status: 503,
        body: "unavailable",
      });
      const api = apiFixture({
        write: (_name, _path, body) =>
          body === undefined
            ? Effect.fail(transportFailure)
            : body.pipe(
                Stream.runDrain,
                Effect.mapError(() => transportFailure),
              ),
      });

      const exit = yield* IncusFileOperations.create(api, "container", "default")
        .write("/tmp/message.txt", Stream.fail(sourceFailure))
        .pipe(Effect.exit);

      expect(errorFrom(exit)).toBe(sourceFailure);
    }),
  );

  it.effect("preserves a transport failure when the source succeeds", () =>
    Effect.gen(function* () {
      const transportFailure = new IncusApi.StatusCodeError({
        method: "POST",
        path: "/files",
        status: 503,
        body: "unavailable",
      });
      const api = apiFixture({
        write: (_name, _path, body) =>
          body === undefined
            ? Effect.fail(transportFailure)
            : body.pipe(
                Stream.runDrain,
                Effect.mapError(() => transportFailure),
                Effect.andThen(Effect.fail(transportFailure)),
              ),
      });

      const exit = yield* IncusFileOperations.create(api, "container", "default")
        .write("/tmp/message.txt", Stream.make(new Uint8Array([1])))
        .pipe(Effect.exit);

      expect(errorFrom(exit)).toBe(transportFailure);
    }),
  );
});
