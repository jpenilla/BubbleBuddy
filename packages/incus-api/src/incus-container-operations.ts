import { Cause, Effect, Exit } from "effect";

import { IncusContainer } from "./incus-container.ts";
import { IncusExecSession } from "./incus-exec-session.ts";
import { IncusFileOperations } from "./incus-file-operations.ts";
import type { IncusApi } from "./incus-api.ts";

export const create = (
  project: string,
  api: IncusApi.Interface,
): IncusContainer.ContainerCollection => ({
  scoped: (options) =>
    Effect.acquireRelease(acquire(project, api, options), (container, exit) =>
      release(api, container, exit),
    ),
  exists: (name) => api.instances.exists(name, { project }),
});

const acquire = Effect.fn("IncusContainer.acquire")(function* (
  project: string,
  api: IncusApi.Interface,
  options: IncusContainer.CreateOptions,
) {
  const name = options.name ?? `incus-api-${crypto.randomUUID().slice(0, 8)}`;
  const attributes = { containerName: name, incusProject: project };
  yield* Effect.annotateCurrentSpan(attributes);
  const container = createContainer(project, api, name);

  const operation = yield* api.instances.create(
    {
      name,
      type: "container",
      ephemeral: true,
      ...(options.profiles === undefined ? {} : { profiles: [...options.profiles] }),
      config: containerConfig(options.limits),
      devices: devices(options),
      source: source(options.image),
      start: true,
    },
    { project },
  );
  yield* Effect.annotateCurrentSpan("incusOperationId", operation.id);
  yield* api.operations
    .wait(operation.id, { project })
    .pipe(
      Effect.onError(() =>
        cleanup(api, container).pipe(
          Effect.ignore({ log: "Warn", message: "Incus container cleanup failed" }),
          Effect.annotateLogs(attributes),
        ),
      ),
    );
  return container;
});

const release = (
  api: IncusApi.Interface,
  container: IncusContainer.Container,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void, never> =>
  cleanup(api, container).pipe(
    Effect.onError((cause) =>
      Effect.logError("Incus container cleanup failed", cause).pipe(
        Effect.annotateLogs({
          containerName: container.name,
          incusProject: container.project,
          scopeExit: exit._tag,
        }),
      ),
    ),
    Effect.withSpan("IncusContainer.release", {
      attributes: { containerName: container.name, incusProject: container.project },
    }),
    Effect.ignoreCause(),
  );

const cleanup = (
  api: IncusApi.Interface,
  container: IncusContainer.Container,
): Effect.Effect<void, IncusApi.ApiError> =>
  stop(api, container.project, container.name, { force: true }).pipe(
    Effect.catchCause((cause: Cause.Cause<IncusApi.ApiError>) =>
      Effect.logWarning(
        "Incus container stop failed during cleanup; attempting delete",
        cause,
      ).pipe(
        Effect.annotateLogs({ containerName: container.name, incusProject: container.project }),
        Effect.andThen(deleteContainer(api, container.project, container.name)),
      ),
    ),
  );

const stop = Effect.fn("IncusContainer.stop")(function* (
  api: IncusApi.Interface,
  project: string,
  name: string,
  options: { readonly force?: boolean; readonly timeoutSeconds?: number } = {},
) {
  yield* Effect.annotateCurrentSpan({ containerName: name, incusProject: project });
  const operation = yield* api.instances.setState(
    name,
    {
      action: "stop",
      timeout: options.timeoutSeconds ?? (options.force ? 0 : 30),
      ...(options.force === undefined ? {} : { force: options.force }),
    },
    { project },
  );
  yield* Effect.annotateCurrentSpan("incusOperationId", operation.id);
  yield* api.operations.wait(operation.id, {
    project,
    timeoutSeconds: options.timeoutSeconds,
  });
});

const deleteContainer = Effect.fn("IncusContainer.delete")(function* (
  api: IncusApi.Interface,
  project: string,
  name: string,
) {
  yield* Effect.annotateCurrentSpan({ containerName: name, incusProject: project });
  const operation = yield* api.instances.delete(name, { project });
  yield* Effect.annotateCurrentSpan("incusOperationId", operation.id);
  yield* api.operations.wait(operation.id, { project });
});

const createContainer = (
  project: string,
  api: IncusApi.Interface,
  name: string,
): IncusContainer.Container => ({
  name,
  project,
  exec: Effect.fn("IncusContainer.exec", {
    attributes: { containerName: name, incusProject: project },
  })(function* (command: readonly string[], options?: IncusContainer.ExecOptions) {
    return yield* IncusExecSession.exec(name, project, api, command, options);
  }),
  files: IncusFileOperations.create(api, name, project),
});

const source = (image: IncusContainer.ImageSource): IncusApi.InstanceCreateRequest["source"] =>
  image.type === "local"
    ? { type: "image", fingerprint: image.fingerprint }
    : {
        type: "image",
        alias: image.alias,
        server: image.server ?? "https://images.linuxcontainers.org",
        protocol: image.protocol ?? "simplestreams",
      };

const containerConfig = (limits?: IncusContainer.ResourceLimits) => ({
  ...(limits?.cpu ? { "limits.cpu": limits.cpu } : {}),
  ...(limits?.memory ? { "limits.memory": limits.memory } : {}),
});

const devices = (
  options: IncusContainer.CreateOptions,
): NonNullable<IncusApi.InstanceCreateRequest["devices"]> =>
  Object.fromEntries(
    (options.mounts ?? []).map((mount, index) => {
      const device: NonNullable<IncusApi.InstanceCreateRequest["devices"]>[string] = {
        type: "disk",
        source: mount.source,
        path: mount.path,
        readonly: String(mount.readonly ?? false),
        required: String(mount.required ?? true),
        shift: String(mount.shift ?? true),
      };
      return [`mount${index}`, device];
    }),
  );

export * as IncusContainerOperations from "./incus-container-operations.ts";
