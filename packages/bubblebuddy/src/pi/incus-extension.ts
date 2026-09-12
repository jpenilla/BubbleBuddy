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
import { GuestPath, IncusContainer } from "incus-api";

import { SessionContainer } from "../session/session-container.ts";
import { AgentToolError } from "./effect-tool.ts";

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const createIncusExtension = Effect.gen(function* () {
  const sessionContainer = yield* SessionContainer.Service;
  const runPromise = yield* FiberSet.makeRuntimePromise();

  const withContainer = <A, E>(
    effect: (container: IncusContainer.Container) => Effect.Effect<A, E>,
  ) => Effect.flatMap(sessionContainer.get, effect);

  const readOperations: ReadOperations = {
    access: async (path) => {
      const result = await runPromise(
        withContainer((container) =>
          container.exec(["/bin/sh", "-lc", `test -r ${shQuote(path)}`]),
        ).pipe(Effect.withSpan("IncusExtension.read.access", { root: true })),
      );
      if (result.exitCode !== 0) {
        throw new Error(`File not readable: ${path}`);
      }
    },
    detectImageMimeType: async (path) => {
      try {
        const chunks: Uint8Array[] = [];
        await runPromise(
          withContainer((container) =>
            container.exec(
              ["/bin/sh", "-lc", `head -c ${IMAGE_TYPE_SNIFF_BYTES} ${shQuote(path)}`],
              {
                onStdout: (chunk) =>
                  Effect.sync(() => {
                    chunks.push(chunk.slice());
                  }),
              },
            ),
          ).pipe(Effect.withSpan("IncusExtension.read.detectImageMimeType", { root: true })),
        );
        return detectSupportedImageMimeType(Buffer.concat(chunks));
      } catch {
        return null;
      }
    },
    readFile: async (path) => {
      const data = await runPromise(
        withContainer((container) =>
          GuestPath.of(path).pipe(Effect.flatMap(container.files.readBytes)),
        ).pipe(Effect.withSpan("IncusExtension.read.readFile", { root: true })),
      );
      return Buffer.from(data);
    },
  };

  const writeOperations: WriteOperations = {
    mkdir: async (dir) => {
      await runPromise(
        withContainer((container) =>
          GuestPath.of(dir).pipe(
            Effect.flatMap((path) => container.files.mkdir(path, { recursive: true })),
          ),
        ).pipe(Effect.withSpan("IncusExtension.write.mkdir", { root: true })),
      );
    },
    writeFile: async (path, content) => {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      await runPromise(
        withContainer((container) =>
          GuestPath.of(path).pipe(
            Effect.flatMap((path) =>
              container.files.write(path, Stream.make(bytes), { createParents: true }),
            ),
          ),
        ).pipe(Effect.withSpan("IncusExtension.write.writeFile", { root: true })),
      );
    },
  };

  const editOperations: EditOperations = {
    access: async (path) => {
      const result = await runPromise(
        withContainer((container) =>
          container.exec([
            "/bin/sh",
            "-lc",
            `test -r ${shQuote(path)} && test -w ${shQuote(path)}`,
          ]),
        ).pipe(Effect.withSpan("IncusExtension.edit.access", { root: true })),
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
        withContainer((container) =>
          container.exec(["/bin/bash", "-c", command], {
            cwd,
            timeoutSeconds,
            onStdout: (chunk) => Effect.sync(() => execOptions.onData(Buffer.from(chunk))),
            onStderr: (chunk) => Effect.sync(() => execOptions.onData(Buffer.from(chunk))),
          }),
        ).pipe(
          Effect.catchCause((cause) => {
            if (execOptions.signal?.aborted || Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            const error = Cause.findErrorOption(cause);
            if (Option.isSome(error) && error.value instanceof IncusContainer.ExecTimeoutError) {
              return Effect.fail(new AgentToolError({ message: `timeout:${timeoutSec}` }));
            }
            return Effect.logError("Sandbox bash command failed", cause).pipe(
              Effect.annotateLogs({ toolName: "bash" }),
              Effect.andThen(
                Effect.fail(new AgentToolError({ message: "Sandbox internal error" })),
              ),
            );
          }),
          Effect.withSpan("IncusExtension.bash.exec", {
            root: true,
            attributes: { toolName: "bash" },
          }),
          Effect.exit,
        ),
        { signal: execOptions.signal },
      );

      if (Exit.isSuccess(exit)) {
        return { exitCode: exit.value.exitCode };
      }
      if (execOptions.signal?.aborted || Cause.hasInterruptsOnly(exit.cause)) {
        throw new Error("aborted");
      }

      throw Cause.squash(exit.cause);
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
