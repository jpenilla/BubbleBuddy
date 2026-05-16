import { Cause, Data, Effect, Exit, Scope } from "effect";
import { posix } from "node:path";

import { type IncusApiError, type IncusApiService } from "./api.ts";
import { type IncusConfigService } from "./config.ts";
import {
  IncusContainerExecCallbackError,
  IncusContainerExecInvalidOptionsError,
  IncusContainerExecTimeoutError,
  IncusContainerExecTransportError,
  execStream,
  type IncusExecOptions,
  type IncusExecResult,
} from "./exec.ts";
import { type IncusOperationsError, type IncusOperationsService } from "./operations.ts";

export class IncusContainerPathError extends Data.TaggedError("IncusContainerPathError")<{
  readonly path: string;
  readonly message: string;
  readonly metadata?: unknown;
}> {}

export class IncusContainerMetadataError extends Data.TaggedError("IncusContainerMetadataError")<{
  readonly operation: string;
  readonly message: string;
  readonly metadata: unknown;
}> {}

export type IncusContainerError =
  | IncusApiError
  | IncusOperationsError
  | IncusContainerPathError
  | IncusContainerMetadataError
  | IncusContainerExecCallbackError
  | IncusContainerExecInvalidOptionsError
  | IncusContainerExecTimeoutError
  | IncusContainerExecTransportError;

export type IncusImage =
  | {
      readonly type: "local";
      /** Local image alias or fingerprint known to the Incus server. */
      readonly alias: string;
    }
  | {
      readonly type: "remote";
      readonly alias: string;
      readonly server?: string;
      /** Incus image source protocol, for example "simplestreams". */
      readonly protocol?: string;
    };

export interface IncusMount {
  readonly source: string;
  readonly path: string;
  readonly readonly?: boolean;
  readonly required?: boolean;
  /** Container-only uid/gid shifting overlay for host path mounts. Defaults to true in v1. */
  readonly shift?: boolean;
}

export interface IncusLimits {
  readonly cpu?: string;
  readonly memory?: string;
}
export interface IncusContainerOptions {
  readonly name?: string;
  readonly image: IncusImage;
  readonly profiles?: readonly string[];
  readonly mounts?: readonly IncusMount[];
  readonly limits?: IncusLimits;
}

export interface IncusFileWriteOptions {
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly createParents?: boolean;
}
export interface IncusContainer {
  readonly name: string;
  readonly project: string;
  readonly exec: (
    command: readonly string[],
    options?: IncusExecOptions,
  ) => Effect.Effect<IncusExecResult, IncusContainerError>;
  readonly files: {
    readonly readBytes: (path: string) => Effect.Effect<Uint8Array, IncusContainerError>;
    readonly readText: (path: string) => Effect.Effect<string, IncusContainerError>;
    readonly write: (
      path: string,
      content: Uint8Array | string,
      options?: IncusFileWriteOptions,
    ) => Effect.Effect<void, IncusContainerError>;
    readonly mkdir: (
      path: string,
      options?: { readonly recursive?: boolean },
    ) => Effect.Effect<void, IncusContainerError>;
  };
}

export interface IncusContainers {
  readonly scoped: (
    options: IncusContainerOptions,
  ) => Effect.Effect<IncusContainer, IncusContainerError, Scope.Scope>;
  readonly exists: (name: string) => Effect.Effect<boolean, IncusContainerError>;
}

export const make = (
  project: string,
  api: IncusApiService,
  operations: IncusOperationsService,
  config: IncusConfigService,
): IncusContainers => ({
  scoped: (options) =>
    Effect.acquireRelease(acquire(project, api, operations, config, options), (container, exit) =>
      release(api, operations, container, exit),
    ),
  exists: (name) => api.instances.exists(name, { project }),
});

const acquire = (
  project: string,
  api: IncusApiService,
  operations: IncusOperationsService,
  config: IncusConfigService,
  options: IncusContainerOptions,
): Effect.Effect<IncusContainer, IncusContainerError> =>
  Effect.gen(function* () {
    const name = options.name ?? `incus-api-${crypto.randomUUID().slice(0, 8)}`;
    const container = makeContainer(project, api, operations, config, name);

    const operation = yield* api.instances.create(
      {
        name,
        type: "container",
        ephemeral: true,
        profiles: options.profiles === undefined ? undefined : [...options.profiles],
        config: containerConfig(options.limits),
        devices: devices(options),
        source: source(options.image),
        start: true,
      },
      { project },
    );
    yield* operations
      .wait(operation.id, { project })
      .pipe(Effect.onError(() => cleanup(api, operations, container).pipe(Effect.ignore)));
    return container;
  });

const release = (
  api: IncusApiService,
  operations: IncusOperationsService,
  container: IncusContainer,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void, never> =>
  cleanup(api, operations, container).pipe(
    Effect.catchCause((cause: Cause.Cause<IncusContainerError>) =>
      Effect.logWarning(
        exit._tag === "Success"
          ? "Incus container cleanup failed after successful scope exit"
          : "Incus container cleanup failed after failed/interrupted scope exit",
        { container: container.name, project: container.project, cause: Cause.pretty(cause) },
      ),
    ),
  );

const cleanup = (
  api: IncusApiService,
  operations: IncusOperationsService,
  container: IncusContainer,
): Effect.Effect<void, IncusContainerError> =>
  stop(api, operations, container.project, container.name, { force: true }).pipe(
    Effect.catchCause((cause: Cause.Cause<IncusContainerError>) =>
      Effect.logWarning("Incus container stop failed during cleanup; attempting delete", {
        container: container.name,
        project: container.project,
        cause: Cause.pretty(cause),
      }).pipe(Effect.andThen(deleteContainer(api, operations, container.project, container.name))),
    ),
  );

const stop = Effect.fn("IncusContainer.stop")(function* (
  api: IncusApiService,
  operations: IncusOperationsService,
  project: string,
  name: string,
  options: { readonly force?: boolean; readonly timeoutSeconds?: number } = {},
) {
  const operation = yield* api.instances.setState(
    name,
    {
      action: "stop",
      timeout: options.timeoutSeconds ?? (options.force ? 0 : 30),
      force: options.force,
    },
    { project },
  );
  yield* operations.wait(operation.id, {
    project,
    timeoutSeconds: options.timeoutSeconds,
  });
});

const deleteContainer = Effect.fn("IncusContainer.delete")(function* (
  api: IncusApiService,
  operations: IncusOperationsService,
  project: string,
  name: string,
) {
  const operation = yield* api.instances.delete(name, { project });
  yield* operations.wait(operation.id, { project });
});

const makeContainer = (
  project: string,
  api: IncusApiService,
  operations: IncusOperationsService,
  config: IncusConfigService,
  name: string,
): IncusContainer => {
  const projectOptions = { project };

  const exec = Effect.fn("IncusContainer.exec")(function* (
    command: readonly string[],
    options?: IncusExecOptions,
  ) {
    return yield* execStream(name, project, api, operations, config, command, options);
  });

  const writeFile: IncusContainer["files"]["write"] = Effect.fn("IncusContainer.writeFile")(
    function* (p: string, content: Uint8Array | string, o?: IncusFileWriteOptions) {
      if (o?.createParents) {
        yield* ensureParentDirectories(api, name, project, p, { uid: o.uid, gid: o.gid });
      }
      yield* api.instances.files.write(name, p, content, fileHeaders("file", o), projectOptions);
    },
  );

  const mkdir: IncusContainer["files"]["mkdir"] = Effect.fn("IncusContainer.mkdir")(function* (
    p: string,
    options?: { readonly recursive?: boolean },
  ) {
    if (options?.recursive) {
      yield* createDirectories(api, name, project, p);
    } else {
      yield* api.instances.files.write(
        name,
        p,
        undefined,
        fileHeaders("directory"),
        projectOptions,
      );
    }
  });

  return {
    name,
    project,
    exec,
    files: {
      readBytes: (p) =>
        api.instances.files
          .readBytes(name, p, projectOptions)
          .pipe(Effect.withSpan("IncusContainer.files.readBytes")),
      readText: (p) =>
        api.instances.files
          .readText(name, p, projectOptions)
          .pipe(Effect.withSpan("IncusContainer.files.readText")),
      write: writeFile,
      mkdir,
    },
  };
};

const ensureParentDirectories = (
  api: IncusApiService,
  name: string,
  project: string,
  path: string,
  fileOptions?: IncusFileWriteOptions,
) =>
  createDirectories(api, name, project, posix.dirname(normalizeContainerPath(path)), fileOptions);

const createDirectories = (
  api: IncusApiService,
  name: string,
  project: string,
  path: string,
  fileOptions?: IncusFileWriteOptions,
) =>
  Effect.forEach(
    directoryChain(path),
    (directory) => ensureDirectory(api, name, project, directory, fileOptions),
    { discard: true },
  );

const ensureDirectory = (
  api: IncusApiService,
  name: string,
  project: string,
  path: string,
  fileOptions?: IncusFileWriteOptions,
) =>
  api.instances.files.stat(name, path, { project }).pipe(
    Effect.flatMap((info): Effect.Effect<void, IncusApiError | IncusContainerPathError> => {
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
        new IncusContainerPathError({
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

const fileHeaders = (type: string, o?: IncusFileWriteOptions) => ({
  "x-incus-type": type,
  ...(o?.uid === undefined ? {} : { "x-incus-uid": String(o.uid) }),
  ...(o?.gid === undefined ? {} : { "x-incus-gid": String(o.gid) }),
  ...(o?.mode === undefined ? {} : { "x-incus-mode": String(o.mode) }),
});

const source = (image: IncusImage) =>
  image.type === "local"
    ? { type: "image", alias: image.alias }
    : {
        type: "image",
        alias: image.alias,
        server: image.server ?? "https://images.linuxcontainers.org",
        protocol: image.protocol ?? "simplestreams",
      };

const containerConfig = (limits?: IncusLimits) => ({
  ...(limits?.cpu ? { "limits.cpu": limits.cpu } : {}),
  ...(limits?.memory ? { "limits.memory": limits.memory } : {}),
});

const devices = (options: IncusContainerOptions) =>
  Object.fromEntries(
    (options.mounts ?? []).map((mount, index) => [
      `mount${index}`,
      {
        type: "disk",
        source: mount.source,
        path: mount.path,
        readonly: String(mount.readonly ?? false),
        required: String(mount.required ?? true),
        shift: String(mount.shift ?? true),
      },
    ]),
  );
