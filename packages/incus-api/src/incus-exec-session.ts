import { Effect, Fiber, Schema } from "effect";
import * as Socket from "effect/unstable/socket/Socket";

import { IncusApi } from "./incus-api.ts";
import { IncusContainer } from "./incus-container.ts";

const ExecResultMetadata = Schema.Struct({ return: Schema.Int });
const ExecWebSocketSecrets = Schema.Struct({
  "0": Schema.String,
  "1": Schema.String,
  "2": Schema.String,
  control: Schema.String,
});
type ExecWebSocketSecrets = typeof ExecWebSocketSecrets.Type;

interface ExecLifecycle {
  controlConnected: boolean;
  terminal: boolean;
}

const execPayload = (
  command: readonly string[],
  options: IncusContainer.ExecOptions | undefined,
): IncusApi.InstanceExecRequest => ({
  command: [...command],
  interactive: false,
  "wait-for-websocket": true,
  ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options?.environment === undefined ? {} : { environment: options.environment }),
});

const decodeExecWebSocketSecrets = (
  operation: IncusApi.ExecOperationRef,
): Effect.Effect<ExecWebSocketSecrets, IncusApi.OperationError> =>
  Schema.decodeUnknownEffect(ExecWebSocketSecrets)(operation.websocketSecrets).pipe(
    Effect.mapError(
      (cause) =>
        new IncusApi.OperationError({
          operation: operation.id,
          message: "Failed to decode Incus exec websocket secrets",
          metadata: { cause, websocketSecrets: operation.websocketSecrets },
        }),
    ),
  );

const consumeOutput = Effect.fn("IncusExecSession.consumeOutput")(function* (
  reader: Socket.Reader,
  callback: IncusContainer.OutputCallback | undefined,
) {
  while (true) {
    const batch = yield* reader.pull;
    for (const frame of batch) {
      // Incus ends each output stream with a text frame (its write barrier) and then drops the
      // socket, so the barrier is the only end-of-stream signal.
      if (typeof frame === "string") return;
      if (callback) {
        yield* callback(frame).pipe(
          Effect.mapError((cause) => new IncusContainer.ExecCallbackError({ cause })),
        );
      }
    }
  }
});

const waitExecResult = Effect.fn("IncusExecSession.waitExecResult")(function* (
  api: IncusApi.Interface,
  operationId: string,
  project: string,
  timeoutSeconds: number | undefined,
  lifecycle: ExecLifecycle,
) {
  const result = yield* api.operations.wait(operationId, {
    project,
    timeoutSeconds,
    failureMode: "return",
  });
  // Terminal state is recorded before any failure path below so teardown can skip termination.
  if (!IncusApi.OperationWaitResult.$is("Running")(result)) {
    lifecycle.terminal = true;
  } else {
    if (timeoutSeconds !== undefined) {
      return yield* new IncusContainer.ExecTimeoutError({ timeoutSeconds });
    }
    return yield* new IncusApi.OperationError({
      operation: operationId,
      message: "Incus exec operation is still running",
      metadata: result.metadata,
    });
  }

  const metadata = yield* Schema.decodeUnknownEffect(ExecResultMetadata)(result.metadata).pipe(
    Effect.mapError(
      (cause) =>
        new IncusApi.OperationError({
          operation: operationId,
          message: "Failed to decode Incus operation response",
          metadata: { cause, body: { metadata: result.metadata } },
        }),
    ),
  );

  return { exitCode: metadata.return };
});

const confirmExecTermination = Effect.fn("IncusExecSession.confirmExecTermination")(function* (
  api: IncusApi.Interface,
  project: string,
  operation: IncusApi.OperationRef,
  lifecycle: ExecLifecycle,
) {
  // No control connection means Incus never started the command and ends the operation itself
  // after its required-websocket wait, so there is nothing to cancel.
  if (lifecycle.terminal || !lifecycle.controlConnected) return;

  // Closing the control socket makes Incus hard-kill the command (no SIGTERM, no descendants),
  // matching Pi's bash tool. This confirms the operation ended and is bounded locally only.
  yield* api.operations
    .wait(operation.id, { project, failureMode: "return" })
    // Make the locally bounded wait interruptible; teardown runs uninterruptible by default.
    .pipe(Effect.timeout("3 seconds"), Effect.interruptible, Effect.asVoid);
});

export const exec = Effect.fnUntraced(
  function* (
    name: string,
    project: string,
    api: IncusApi.Interface,
    command: readonly string[],
    options?: IncusContainer.ExecOptions,
  ) {
    const timeoutSeconds = options?.timeoutSeconds;
    if (
      timeoutSeconds !== undefined &&
      (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)
    ) {
      return yield* new IncusContainer.ExecInvalidOptionsError({
        message: `Invalid timeoutSeconds: ${timeoutSeconds}. Must be a positive integer.`,
      });
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const lifecycle: ExecLifecycle = { controlConnected: false, terminal: false };
        // Registered before the sockets, so teardown closes them first and that control close is
        // what makes Incus kill the command.
        const operation = yield* api.instances.exec(
          name,
          execPayload(command, options),
          { project },
          (operation) =>
            confirmExecTermination(api, project, operation, lifecycle).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Incus exec termination was not confirmed", cause).pipe(
                  Effect.annotateLogs({
                    containerName: name,
                    incusProject: project,
                    incusOperationId: operation.id,
                  }),
                ),
              ),
            ),
        );
        yield* Effect.annotateCurrentSpan("incusOperationId", operation.id);
        const secrets = yield* decodeExecWebSocketSecrets(operation);
        const connect = Effect.fnUntraced(function* (secret: string) {
          const socket = yield* api.operations.makeWebSocket(operation.id, secret, {
            openTimeout: 5000,
          });
          const reader = yield* socket.reader;
          return { socket, reader };
        });

        yield* connect(secrets.control);
        lifecycle.controlConnected = true;
        const { stdin, stdout, stderr } = yield* Effect.all(
          {
            stdin: connect(secrets["0"]),
            stdout: connect(secrets["1"]),
            stderr: connect(secrets["2"]),
          },
          { concurrency: "unbounded" },
        );
        const writer = yield* stdin.socket.writer;

        // Stdin is not exposed by this API, so send the stream barrier immediately: Incus treats
        // a text frame as end-of-input, which lets commands that wait for EOF, such as `cat`,
        // exit instead of hanging forever.
        yield* writer.write("");
        const output = yield* Effect.all(
          [
            consumeOutput(stdout.reader, options?.onStdout),
            consumeOutput(stderr.reader, options?.onStderr),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.forkScoped);
        // Propagate output failures while still waiting for the command's exit code.
        const outputFailure = Fiber.join(output).pipe(Effect.andThen(Effect.never));
        const result = yield* Effect.raceFirst(
          waitExecResult(api, operation.id, project, timeoutSeconds, lifecycle),
          outputFailure,
        );
        yield* Fiber.join(output).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () =>
              Effect.fail(
                new IncusContainer.ExecTransportError({
                  message: "Timed out waiting for exec output callbacks to drain",
                }),
              ),
          }),
        );
        return result;
      }),
    ).pipe(
      Effect.catchIf(
        (error): error is Socket.SocketError => error instanceof Socket.SocketError,
        (error) =>
          Effect.fail(
            new IncusContainer.ExecTransportError({
              message: `Websocket error: ${error.message}`,
              cause: error,
            }),
          ),
      ),
    );
  },
  Effect.withSpan("IncusExecSession.exec", (name, project) => ({
    attributes: { containerName: name, incusProject: project },
  })),
);

export * as IncusExecSession from "./incus-exec-session.ts";
