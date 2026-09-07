import { Effect, Option, Ref, Stream } from "effect";
import { posix } from "node:path";

import { IncusContainer } from "./incus-container.ts";
import type { IncusApi } from "./transport/incus-api.ts";

export const create = (
  api: IncusApi.Interface,
  name: string,
  project: string,
): IncusContainer.FileOperations => {
  const projectOptions = { project };

  const openRead: IncusContainer.Container["files"]["openRead"] = Effect.fn(
    "IncusContainer.openRead",
  )(function* (path: string) {
    yield* requireAbsolutePath(path);
    const response = yield* api.instances.files.openRead(name, path, projectOptions);
    if (response.type !== "file") {
      return yield* new IncusContainer.MetadataError({
        operation: "openRead",
        message: `Path is not a regular file: ${path}`,
        metadata: { path, type: response.type },
      });
    }
    return { size: response.size, bytes: response.bytes };
  });

  const write: IncusContainer.Container["files"]["write"] = Effect.fn("IncusContainer.writeFile")(
    function* <E, R>(
      path: string,
      content: Stream.Stream<Uint8Array, E, R>,
      options?: IncusContainer.FileWriteOptions,
    ) {
      yield* requireAbsolutePath(path);
      const context = yield* Effect.context<R>();
      const sourceError = yield* Ref.make(Option.none<E>());
      const body: Stream.Stream<Uint8Array, E, never> = content.pipe(
        Stream.tapError((error) => Ref.set(sourceError, Option.some(error))),
        Stream.provideContext(context),
      );
      if (options?.createParents) {
        yield* ensureParentDirectories(api, name, project, path, {
          uid: options.uid,
          gid: options.gid,
        });
      }
      yield* api.instances.files
        .write(name, path, body, fileHeaders("file", options), projectOptions)
        .pipe(
          Effect.catch((error) =>
            Ref.get(sourceError).pipe(
              Effect.flatMap((source): Effect.Effect<never, E | IncusApi.ApiError> =>
                Option.isSome(source) ? Effect.fail(source.value) : Effect.fail(error),
              ),
            ),
          ),
        );
    },
  );

  const mkdir: IncusContainer.Container["files"]["mkdir"] = Effect.fn("IncusContainer.mkdir")(
    function* (path: string, options?: { readonly recursive?: boolean }) {
      yield* requireAbsolutePath(path);
      if (options?.recursive) {
        yield* createDirectories(api, name, project, path);
      } else {
        yield* api.instances.files.write(
          name,
          path,
          undefined,
          fileHeaders("directory"),
          projectOptions,
        );
      }
    },
  );

  return {
    openRead,
    readBytes: (path) =>
      Effect.scoped(
        openRead(path).pipe(
          Effect.flatMap((file) => file.bytes.pipe(Stream.runCollect)),
          Effect.map(concatBytes),
        ),
      ).pipe(Effect.withSpan("IncusContainer.files.readBytes")),
    readText: (path) =>
      Effect.scoped(
        openRead(path).pipe(
          Effect.flatMap((file) => file.bytes.pipe(Stream.decodeText(), Stream.runCollect)),
          Effect.map((chunks) => Array.from(chunks).join("")),
        ),
      ).pipe(Effect.withSpan("IncusContainer.files.readText")),
    write,
    mkdir,
  };
};

const requireAbsolutePath = (path: string) =>
  posix.isAbsolute(path)
    ? Effect.void
    : Effect.fail(
        new IncusContainer.PathError({ path, message: "Incus container paths must be absolute" }),
      );

const concatBytes = (chunks: Iterable<Uint8Array>): Uint8Array => {
  const values = Array.from(chunks);
  const length = values.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of values) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const ensureParentDirectories = (
  api: IncusApi.Interface,
  name: string,
  project: string,
  path: string,
  fileOptions?: IncusContainer.FileWriteOptions,
) =>
  createDirectories(api, name, project, posix.dirname(normalizeContainerPath(path)), fileOptions);

const createDirectories = (
  api: IncusApi.Interface,
  name: string,
  project: string,
  path: string,
  fileOptions?: IncusContainer.FileWriteOptions,
) =>
  Effect.forEach(
    directoryChain(path),
    (directory) => ensureDirectory(api, name, project, directory, fileOptions),
    { discard: true },
  );

const ensureDirectory = (
  api: IncusApi.Interface,
  name: string,
  project: string,
  path: string,
  fileOptions?: IncusContainer.FileWriteOptions,
) =>
  api.instances.files.stat(name, path, { project }).pipe(
    Effect.flatMap((info): Effect.Effect<void, IncusApi.ApiError | IncusContainer.PathError> => {
      if (info === null) {
        return api.instances.files.write(
          name,
          path,
          undefined,
          fileHeaders("directory", fileOptions),
          { project },
        );
      }
      if (info.type === "directory") return Effect.void;
      return Effect.fail(
        new IncusContainer.PathError({
          path,
          message: `Path exists but is not a directory: ${path}`,
          metadata: { fileType: info.type },
        }),
      );
    }),
  );

const normalizeContainerPath = (path: string) => {
  const normalized = posix.normalize(path);
  if (normalized === ".") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
};

const directoryChain = (path: string): ReadonlyArray<string> => {
  const normalized = normalizeContainerPath(path);
  if (normalized === "/") return [];
  const parts = normalized.split("/").filter(Boolean);
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`);
};

const fileHeaders = (type: string, options?: IncusContainer.FileWriteOptions) => ({
  "x-incus-type": type,
  ...(options?.uid === undefined ? {} : { "x-incus-uid": String(options.uid) }),
  ...(options?.gid === undefined ? {} : { "x-incus-gid": String(options.gid) }),
  ...(options?.mode === undefined ? {} : { "x-incus-mode": String(options.mode) }),
});

export * as IncusFileOperations from "./incus-file-operations.ts";
