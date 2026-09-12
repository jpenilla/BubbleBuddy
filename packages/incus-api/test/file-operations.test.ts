import { GuestPath } from "../src/guest-path.ts";
import { Context, Effect, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { assertInstanceOf } from "@effect/vitest/utils";

import { IncusFileOperations } from "../src/incus-file-operations.ts";
import { IncusApi } from "../src/incus-api.ts";
import { IncusContainer } from "../src/incus-container.ts";
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
  it.effect("creates missing parents before uploading the file", () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const api = apiFixture({
        stat: (_name, path) =>
          Effect.succeed(path === "/" || path === "/tmp" ? { type: "directory" } : null),
        write: (_name, path, _body, headers) =>
          Effect.sync(() => {
            writes.push([path, headers["x-incus-type"]]);
          }),
      });
      yield* IncusFileOperations.create(api, "container", "default").write(
        yield* GuestPath.of("/tmp/a/b/message.txt"),
        Stream.empty,
        { createParents: true },
      );
      expect(writes).toEqual([
        ["/tmp/a", "directory"],
        ["/tmp/a/b", "directory"],
        ["/tmp/a/b/message.txt", "file"],
      ]);
    }),
  );

  it.effect("does not upload through an obstructed parent", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const api = apiFixture({
        stat: (_name, path) => Effect.succeed({ type: path === "/tmp/a" ? "file" : "directory" }),
        write: (_name, path) =>
          Effect.sync(() => {
            writes.push(path);
          }),
      });
      const error = yield* IncusFileOperations.create(api, "container", "default")
        .write(yield* GuestPath.of("/tmp/a/message.txt"), Stream.empty, { createParents: true })
        .pipe(Effect.flip);
      assertInstanceOf(error, IncusContainer.MetadataError);
      expect(error.metadata).toEqual({ path: "/tmp/a", fileType: "file" });
      expect(writes).toEqual([]);
    }),
  );

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
        .write(yield* GuestPath.of("/tmp/message.txt"), source)
        .pipe(
          Effect.provideService(StreamValue, {
            chunks: [new Uint8Array([0, 1, 2]), new Uint8Array([127, 128, 255])],
          }),
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
        .write(yield* GuestPath.of("/tmp/message.txt"), Stream.fail(sourceFailure))
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
        .write(yield* GuestPath.of("/tmp/message.txt"), Stream.make(new Uint8Array([1])))
        .pipe(Effect.exit);

      expect(errorFrom(exit)).toBe(transportFailure);
    }),
  );
});
