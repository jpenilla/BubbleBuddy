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
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { Incus, IncusContainerExecTimeoutError, type IncusContainer } from "incus-api";

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
        let stdout = "";
        await runInContainer((c) =>
          c.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(path)} 2>/dev/null || true`], {
            onStdout: (chunk) => {
              stdout += new TextDecoder().decode(chunk);
            },
          }),
        );
        const mimeType = stdout.trim();
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
    exec: async (command, cwd, execOptions) => {
      const timeoutSec = execOptions.timeout;
      const timeoutSeconds = timeoutSec !== undefined && timeoutSec > 0 ? timeoutSec : undefined;

      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const container = yield* SessionContainer;
          return yield* container.exec(["/bin/bash", "-c", command], {
            cwd,
            timeoutSeconds,
            onStdout: (chunk) => {
              execOptions.onData(Buffer.from(chunk));
            },
            onStderr: (chunk) => {
              execOptions.onData(Buffer.from(chunk));
            },
          });
        }),
        { signal: execOptions.signal },
      );

      if (Exit.isSuccess(exit)) {
        return { exitCode: exit.value.exitCode };
      }

      if (execOptions.signal?.aborted || Cause.hasInterruptsOnly(exit.cause)) {
        throw new Error("aborted");
      }

      const errorOpt = Cause.findErrorOption(exit.cause);
      if (Option.isSome(errorOpt) && errorOpt.value instanceof IncusContainerExecTimeoutError) {
        throw new Error(`timeout:${timeoutSec}`);
      }

      await Effect.runPromise(
        Effect.logError(
          `Sandbox bash command failed for channel ${options.channelId}: ${Cause.pretty(exit.cause)}`,
        ),
      );
      throw new Error("Sandbox internal error");
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
