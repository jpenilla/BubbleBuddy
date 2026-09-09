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
import { Cause, Effect, Exit, FiberSet, Option, Stream } from "effect";
import { IncusContainer } from "incus-api";

import { SessionContainer } from "../session/session-container.ts";

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const createIncusExtension = Effect.gen(function* () {
  const sessionContainer = yield* SessionContainer.Service;
  const runPromise = yield* FiberSet.makeRuntimePromise();

  const runInContainer = <A, E>(
    effect: (container: IncusContainer.Container) => Effect.Effect<A, E>,
  ): Promise<A> => runPromise(Effect.flatMap(sessionContainer.get, effect));

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
          container.exec(["/bin/sh", "-lc", `head -c ${IMAGE_TYPE_SNIFF_BYTES} ${shQuote(path)}`], {
            onStdout: (chunk) =>
              Effect.sync(() => {
                chunks.push(chunk.slice());
              }),
          }),
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
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      await runInContainer((container) =>
        container.files.write(path, Stream.make(bytes), { createParents: true }),
      );
    },
  };

  const editOperations: EditOperations = {
    access: async (path) => {
      const result = await runInContainer((container) =>
        container.exec(["/bin/sh", "-lc", `test -r ${shQuote(path)} && test -w ${shQuote(path)}`]),
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
        Effect.flatMap(sessionContainer.get, (container) =>
          container.exec(["/bin/bash", "-c", command], {
            cwd,
            timeoutSeconds,
            onStdout: (chunk) => Effect.sync(() => execOptions.onData(Buffer.from(chunk))),
            onStderr: (chunk) => Effect.sync(() => execOptions.onData(Buffer.from(chunk))),
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
      if (Option.isSome(error) && error.value instanceof IncusContainer.ExecTimeoutError) {
        throw new Error(`timeout:${timeoutSec}`);
      }

      await runPromise(Effect.logError(`Sandbox bash command failed: ${Cause.pretty(exit.cause)}`));
      throw new Error("Sandbox internal error");
    },
  };

  return ((pi) => {
    pi.registerTool(createBashToolDefinition(sessionContainer.cwd, { operations: bashOperations }));
    pi.registerTool(createReadToolDefinition(sessionContainer.cwd, { operations: readOperations }));
    pi.registerTool(
      createWriteToolDefinition(sessionContainer.cwd, { operations: writeOperations }),
    );
    pi.registerTool(createEditToolDefinition(sessionContainer.cwd, { operations: editOperations }));
  }) satisfies ExtensionFactory;
});
