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
import {
  detectSupportedImageMimeType,
  IMAGE_TYPE_SNIFF_BYTES,
} from "@earendil-works/pi-coding-agent/utils/mime";
import { Cause, Effect, Exit, FiberSet, Option, Schema, Stream } from "effect";
import { GuestPath, IncusContainer } from "incus-api";

import { SessionContainer } from "../session/session-container.ts";
import { AgentToolError } from "./effect-tool.ts";

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const SESSION_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

const filterSessionEnv = (
  environment: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> => {
  const filtered: Record<string, string> = {};
  for (const key of SESSION_ENV_KEYS) {
    const value = environment?.[key];
    if (value !== undefined) filtered[key] = value;
  }
  return filtered;
};

export const createIncusExtension = Effect.gen(function* () {
  const sessionContainer = yield* SessionContainer.Service;
  const guestPath = yield* GuestPath.Service;
  const runPromise = yield* FiberSet.makeRuntimePromise();

  const withContainer = <A, E>(
    effect: (container: IncusContainer.Container) => Effect.Effect<A, E>,
  ) => Effect.flatMap(sessionContainer.get, effect);

  const readOperations: ReadOperations = {
    // @effect-diagnostics-next-line asyncFunction:off -- Pi's read operation returns a promise.
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
    // @effect-diagnostics-next-line asyncFunction:off -- Pi's MIME detector returns a promise.
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
    // @effect-diagnostics-next-line asyncFunction:off -- Pi's read operation returns a promise.
    readFile: async (path) => {
      const data = await runPromise(
        withContainer((container) =>
          guestPath.of(path).pipe(Effect.flatMap(container.files.readBytes)),
        ).pipe(Effect.withSpan("IncusExtension.read.readFile", { root: true })),
      );
      return Buffer.from(data);
    },
  };

  const writeOperations: WriteOperations = {
    // @effect-diagnostics-next-line asyncFunction:off -- Pi's mkdir operation returns a promise.
    mkdir: async (dir) => {
      await runPromise(
        withContainer((container) =>
          guestPath
            .of(dir)
            .pipe(Effect.flatMap((path) => container.files.mkdir(path, { recursive: true }))),
        ).pipe(Effect.withSpan("IncusExtension.write.mkdir", { root: true })),
      );
    },
    // @effect-diagnostics-next-line asyncFunction:off -- Pi's write operation returns a promise.
    writeFile: async (path, content) => {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      await runPromise(
        withContainer((container) =>
          guestPath
            .of(path)
            .pipe(
              Effect.flatMap((path) =>
                container.files.write(path, Stream.make(bytes), { createParents: true }),
              ),
            ),
        ).pipe(Effect.withSpan("IncusExtension.write.writeFile", { root: true })),
      );
    },
  };

  const editOperations: EditOperations = {
    // @effect-diagnostics-next-line asyncFunction:off -- Pi's edit access operation returns a promise.
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
    // @effect-diagnostics-next-line asyncFunction:off -- Pi's bash operation returns a promise.
    exec: async (command, cwd, execOptions) => {
      const timeoutSec = execOptions.timeout;
      const timeoutSeconds = timeoutSec !== undefined && timeoutSec > 0 ? timeoutSec : undefined;
      const exit = await runPromise(
        withContainer((container) =>
          container.exec(["/bin/bash", "-c", command], {
            cwd,
            environment: filterSessionEnv(execOptions.env),
            timeoutSeconds,
            terminationWaitTimeout: "3 seconds",
            onStdout: (chunk) => Effect.sync(() => execOptions.onData(Buffer.from(chunk))),
            onStderr: (chunk) => Effect.sync(() => execOptions.onData(Buffer.from(chunk))),
          }),
        ).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            Effect.fnUntraced(function* (cause) {
              const error = Cause.findErrorOption(cause);
              if (Option.isSome(error) && Schema.is(IncusContainer.ExecTimeoutError)(error.value)) {
                return yield* new AgentToolError({
                  message: execOptions.signal?.aborted ? "aborted" : `timeout:${timeoutSec}`,
                });
              }
              yield* Effect.logError("Sandbox bash command failed", cause);
              return yield* new AgentToolError({ message: "Sandbox internal error" });
            }),
          ),
          Effect.withSpan("IncusExtension.bash.exec", { root: true }),
          Effect.exit,
        ),
        { signal: execOptions.signal },
      );

      if (Exit.isSuccess(exit)) {
        if (execOptions.signal?.aborted) throw new Error("aborted");
        return { exitCode: exit.value.exitCode };
      }
      if (Cause.hasInterruptsOnly(exit.cause)) throw new Error("aborted");
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
