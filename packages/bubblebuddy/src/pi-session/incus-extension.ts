import { Buffer } from "node:buffer";

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type EditOperations,
  type ExtensionFactory,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { Incus, type IncusContainer } from "incus-api";

export interface IncusExtensionOptions {
  readonly channelId: string;
  readonly sessionCwd: string;
  readonly sessionLabel?: string;
  readonly workspaceDir: string;
}

export interface IncusExtension {
  readonly dispose: () => Promise<void>;
  readonly extensionFactory: ExtensionFactory;
}

const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const debianImage = {
  type: "remote" as const,
  alias: "debian/12",
  server: "https://images.linuxcontainers.org",
};

class SessionContainer extends Context.Service<SessionContainer, IncusContainer>()(
  "bubblebuddy/SessionContainer",
) {}

const makeSessionContainerLayer = (options: IncusExtensionOptions) =>
  Layer.effect(
    SessionContainer,
    Effect.gen(function* () {
      yield* Effect.logInfo(`Starting Incus container for channel ${options.channelId}.`);
      const incus = yield* Incus;
      const container = yield* incus.project("default").containers.scoped({
        image: debianImage,
        profiles: ["default"],
        mounts: [{ source: options.workspaceDir, path: options.sessionCwd }],
      });
      yield* Effect.addFinalizer(() =>
        Effect.logInfo(`Closing Incus container for channel ${options.channelId}.`),
      );
      return container;
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(
          `Failed to start Incus container for channel ${options.channelId}: ${String(error)}`,
        ),
      ),
    ),
  ).pipe(Layer.provide(Incus.liveLocal()));

export const createIncusExtension = (options: IncusExtensionOptions): IncusExtension => {
  const runtime = ManagedRuntime.make(makeSessionContainerLayer(options));

  const dispose = async (): Promise<void> => {
    try {
      await runtime.dispose();
    } catch (error) {
      void Effect.runFork(
        Effect.logWarning(
          `Failed to close Incus container runtime for channel ${options.channelId}: ${String(error)}`,
        ),
      );
    }
  };

  const runInContainer = <A, E>(
    effect: (c: IncusContainer) => Effect.Effect<A, E, never>,
  ): Promise<A> =>
    runtime.runPromise(
      Effect.gen(function* () {
        const container = yield* SessionContainer;
        return yield* effect(container);
      }),
    );

  const readOperations: ReadOperations = {
    access: async (path) => {
      const result = await runInContainer((c) =>
        c.exec(["/bin/sh", "-lc", `test -r ${shQuote(path)}`]),
      );
      if (result.exitCode !== 0) {
        throw new Error(`File not readable: ${path}`);
      }
    },
    detectImageMimeType: async (path) => {
      try {
        const result = await runInContainer((c) =>
          c.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(path)} 2>/dev/null || true`]),
        );
        const mimeType = result.stdout.trim();
        return mimeType.length > 0 && IMAGE_MIME_TYPES.has(mimeType) ? mimeType : null;
      } catch {
        return null;
      }
    },
    readFile: async (path) => {
      const data = await runInContainer((c) => c.files.readBytes(path));
      return Buffer.from(data);
    },
  };

  const writeOperations: WriteOperations = {
    mkdir: async (dir) => {
      await runInContainer((c) => c.files.mkdir(dir, { recursive: true }));
    },
    writeFile: async (path, content) => {
      await runInContainer((c) => c.files.write(path, content, { createParents: true }));
    },
  };

  const editOperations: EditOperations = {
    access: async (path) => {
      const result = await runInContainer((c) =>
        c.exec(["/bin/sh", "-lc", `test -r ${shQuote(path)} && test -w ${shQuote(path)}`]),
      );
      if (result.exitCode !== 0) {
        throw new Error(`File not readable and writable: ${path}`);
      }
    },
    readFile: readOperations.readFile,
    writeFile: writeOperations.writeFile,
  };

  const bashOperations: BashOperations = {
    exec: async (command, cwd, options) => {
      const abortController = new AbortController();
      const onAbort = (): void => abortController.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timeoutSec = options.timeout;
      const timeoutMs = timeoutSec !== undefined && timeoutSec > 0 ? timeoutSec * 1000 : undefined;
      const timeoutHandle =
        timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              abortController.abort();
            }, timeoutMs)
          : undefined;

      try {
        const result = await runInContainer((c) =>
          c.exec(["/bin/bash", "-c", command], {
            cwd,
            signal: abortController.signal,
            timeoutMs,
          }),
        );

        if (result.stdout) {
          options.onData(Buffer.from(result.stdout));
        }
        if (result.stderr) {
          options.onData(Buffer.from(result.stderr));
        }

        return { exitCode: result.exitCode };
      } catch (error) {
        if (options.signal?.aborted) {
          throw new Error("aborted");
        }

        if (timedOut) {
          throw new Error(`timeout:${timeoutSec}`);
        }

        throw error;
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };

  return {
    dispose,
    extensionFactory: (pi) => {
      pi.registerTool(createBashToolDefinition(options.sessionCwd, { operations: bashOperations }));
      pi.registerTool(createReadToolDefinition(options.sessionCwd, { operations: readOperations }));
      pi.registerTool(
        createWriteToolDefinition(options.sessionCwd, { operations: writeOperations }),
      );
      pi.registerTool(createEditToolDefinition(options.sessionCwd, { operations: editOperations }));

      pi.on("session_shutdown", async () => {
        await dispose();
      });
    },
  };
};
