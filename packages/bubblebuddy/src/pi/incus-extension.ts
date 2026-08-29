import { Buffer } from "node:buffer";

import {
  detectSupportedImageMimeType,
  IMAGE_TYPE_SNIFF_BYTES,
} from "@earendil-works/pi-coding-agent/utils/mime";
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
import { Cause, Effect, Exit, FiberSet, Option, ScopedRef, Semaphore } from "effect";
import { Incus, IncusContainerExecTimeoutError, type IncusContainer } from "incus-api";

export interface CreateIncusExtensionInput {
  readonly channelId: string;
  readonly sessionCwd: string;
  readonly workspaceDir: string;
}

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const debianImage = {
  type: "remote" as const,
  alias: "debian/12",
  server: "https://images.linuxcontainers.org",
};

export const createIncusExtension = (input: CreateIncusExtensionInput) =>
  Effect.gen(function* () {
    const incus = yield* Incus;
    const containerRef = yield* ScopedRef.make<IncusContainer | undefined>(() => undefined);
    const containerLock = yield* Semaphore.make(1);
    const runPromise = yield* FiberSet.makeRuntimePromise();

    const getContainer = containerLock.withPermit(
      Effect.gen(function* () {
        const current = yield* ScopedRef.get(containerRef);
        if (current !== undefined) return current;

        yield* ScopedRef.set(
          containerRef,
          Effect.gen(function* () {
            yield* Effect.logInfo(`Starting Incus container for channel ${input.channelId}.`);
            const container = yield* incus.project("default").containers.scoped({
              image: debianImage,
              profiles: ["default"],
              mounts: [{ source: input.workspaceDir, path: input.sessionCwd }],
            });
            yield* Effect.addFinalizer(() =>
              Effect.logInfo(`Closing Incus container for channel ${input.channelId}.`),
            );
            return container;
          }).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                `Failed to start Incus container for channel ${input.channelId}: ${String(error)}`,
              ),
            ),
          ),
        );
        const container = yield* ScopedRef.get(containerRef);
        if (container === undefined) {
          return yield* Effect.die("Incus container acquisition produced no container");
        }
        return container;
      }),
    );

    const runInContainer = <A, E>(
      effect: (container: IncusContainer) => Effect.Effect<A, E>,
    ): Promise<A> => runPromise(Effect.flatMap(getContainer, effect));

    const readOperations: ReadOperations = {
      access: async (path) => {
        const result = await runInContainer((container) =>
          container.exec(["/bin/sh", "-lc", `test -r ${shQuote(path)}`]),
        );
        if (result.exitCode !== 0) {
          throw new Error(`File not readable: ${path}`);
        }
      },
      detectImageMimeType: async (path) => {
        try {
          const chunks: Uint8Array[] = [];
          await runInContainer((container) =>
            container.exec(
              ["/bin/sh", "-lc", `head -c ${IMAGE_TYPE_SNIFF_BYTES} ${shQuote(path)}`],
              {
                onStdout: (chunk) => {
                  chunks.push(chunk.slice());
                },
              },
            ),
          );
          return detectSupportedImageMimeType(Buffer.concat(chunks));
        } catch {
          return null;
        }
      },
      readFile: async (path) => {
        const data = await runInContainer((container) => container.files.readBytes(path));
        return Buffer.from(data);
      },
    };

    const writeOperations: WriteOperations = {
      mkdir: async (dir) => {
        await runInContainer((container) => container.files.mkdir(dir, { recursive: true }));
      },
      writeFile: async (path, content) => {
        await runInContainer((container) =>
          container.files.write(path, content, { createParents: true }),
        );
      },
    };

    const editOperations: EditOperations = {
      access: async (path) => {
        const result = await runInContainer((container) =>
          container.exec([
            "/bin/sh",
            "-lc",
            `test -r ${shQuote(path)} && test -w ${shQuote(path)}`,
          ]),
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
        const exit = await runPromise(
          Effect.flatMap(getContainer, (container) =>
            container.exec(["/bin/bash", "-c", command], {
              cwd,
              timeoutSeconds,
              onStdout: (chunk) => execOptions.onData(Buffer.from(chunk)),
              onStderr: (chunk) => execOptions.onData(Buffer.from(chunk)),
            }),
          ).pipe(Effect.exit),
          { signal: execOptions.signal },
        );

        if (Exit.isSuccess(exit)) {
          return { exitCode: exit.value.exitCode };
        }
        if (execOptions.signal?.aborted || Cause.hasInterruptsOnly(exit.cause)) {
          throw new Error("aborted");
        }

        const error = Cause.findErrorOption(exit.cause);
        if (Option.isSome(error) && error.value instanceof IncusContainerExecTimeoutError) {
          throw new Error(`timeout:${timeoutSec}`);
        }

        await runPromise(
          Effect.logError(
            `Sandbox bash command failed for channel ${input.channelId}: ${Cause.pretty(exit.cause)}`,
          ),
        );
        throw new Error("Sandbox internal error");
      },
    };

    return ((pi) => {
      pi.registerTool(createBashToolDefinition(input.sessionCwd, { operations: bashOperations }));
      pi.registerTool(createReadToolDefinition(input.sessionCwd, { operations: readOperations }));
      pi.registerTool(createWriteToolDefinition(input.sessionCwd, { operations: writeOperations }));
      pi.registerTool(createEditToolDefinition(input.sessionCwd, { operations: editOperations }));
    }) satisfies ExtensionFactory;
  }).pipe(Effect.provide(Incus.liveLocal()));
