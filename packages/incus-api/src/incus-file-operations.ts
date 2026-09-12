import { Effect, Option, Ref, Stream } from "effect";
import { GuestPath } from "./guest-path.ts";

import { IncusContainer } from "./incus-container.ts";
import { IncusApi } from "./incus-api.ts";

export const create = (
  api: IncusApi.Interface,
  name: string,
  project: string,
): IncusContainer.FileOperations => {
  const projectOptions = { project };
  const attributes = { containerName: name, incusProject: project };

  const read: IncusContainer.FileOperations["read"] = Effect.fn("IncusContainer.files.read", {
    attributes,
  })(function* (path: GuestPath.GuestPath) {
    return yield* api.instances.files.read(name, path, projectOptions);
  });

  const readFile: IncusContainer.Container["files"]["readFile"] = Effect.fn(
    "IncusContainer.files.readFile",
    { attributes },
  )(function* (path: GuestPath.GuestPath) {
    const response = yield* read(path);
    const reject = (entry: IncusApi.FileRead) =>
      Effect.fail(
        new IncusContainer.MetadataError({
          operation: "readFile",
          message: `Path is not a regular file: ${path}`,
          metadata: { path, type: entry._tag },
        }),
      );
    return yield* IncusApi.FileRead.$match(response, {
      File: (file) => Effect.succeed(file),
      Symlink: reject,
      Directory: reject,
    });
  });

  const write: IncusContainer.Container["files"]["write"] = Effect.fn(
    "IncusContainer.files.write",
    {
      attributes,
    },
  )(function* <E, R>(
    path: GuestPath.GuestPath,
    content: Stream.Stream<Uint8Array, E, R>,
    options?: IncusContainer.FileWriteOptions,
  ) {
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
  });

  const mkdir: IncusContainer.Container["files"]["mkdir"] = Effect.fn(
    "IncusContainer.files.mkdir",
    {
      attributes,
    },
  )(function* (path: GuestPath.GuestPath, options?: { readonly recursive?: boolean }) {
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
  });

  return {
    read,
    readFile,
    readBytes: (path) =>
      Effect.scoped(
        readFile(path).pipe(
          Effect.flatMap((file) => file.bytes.pipe(Stream.runCollect)),
          Effect.map(concatBytes),
        ),
      ).pipe(Effect.withSpan("IncusContainer.files.readBytes", { attributes })),
    readText: (path) =>
      Effect.scoped(
        readFile(path).pipe(
          Effect.flatMap((file) => file.bytes.pipe(Stream.decodeText(), Stream.runCollect)),
          Effect.map((chunks) => Array.from(chunks).join("")),
        ),
      ).pipe(Effect.withSpan("IncusContainer.files.readText", { attributes })),
    write,
    mkdir,
  };
};

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
  path: GuestPath.GuestPath,
  fileOptions?: IncusContainer.FileWriteOptions,
) => createDirectories(api, name, project, GuestPath.dirname(path), fileOptions);

const createDirectories = (
  api: IncusApi.Interface,
  name: string,
  project: string,
  path: GuestPath.GuestPath,
  fileOptions?: IncusContainer.FileWriteOptions,
) =>
  Effect.forEach(
    GuestPath.directoryChain(path),
    (directory) => ensureDirectory(api, name, project, directory, fileOptions),
    { discard: true },
  );

const ensureDirectory = (
  api: IncusApi.Interface,
  name: string,
  project: string,
  path: GuestPath.GuestPath,
  fileOptions?: IncusContainer.FileWriteOptions,
) =>
  api.instances.files.stat(name, path, { project }).pipe(
    Effect.flatMap(
      (info): Effect.Effect<void, IncusApi.ApiError | IncusContainer.MetadataError> => {
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
          new IncusContainer.MetadataError({
            operation: "ensureDirectory",
            message: `Path exists but is not a directory: ${path}`,
            metadata: { path, fileType: info.type },
          }),
        );
      },
    ),
  );

const fileHeaders = (type: string, options?: IncusContainer.FileWriteOptions) => ({
  "x-incus-type": type,
  ...(options?.uid === undefined ? {} : { "x-incus-uid": String(options.uid) }),
  ...(options?.gid === undefined ? {} : { "x-incus-gid": String(options.gid) }),
  ...(options?.mode === undefined ? {} : { "x-incus-mode": String(options.mode) }),
});

export * as IncusFileOperations from "./incus-file-operations.ts";
