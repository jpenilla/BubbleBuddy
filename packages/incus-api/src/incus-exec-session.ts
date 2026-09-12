import { Cause, Effect, Fiber, Schema, Scope } from "effect";
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
  control: Socket.Writer | undefined;
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
  callback: IncusContainer.ExecOptions["onStdout"],
) {
  while (true) {
    const batch = yield* reader.pull;
    for (const frame of batch) {
      // Incus ends each output stream with an empty text message (its stream barrier), then
      // drops the socket without a close frame, so the barrier is the only end-of-stream signal.
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
  yield* Effect.uninterruptible(
    Effect.sync(() => {
      if (!IncusApi.OperationWaitResult.$is("Running")(result)) lifecycle.terminal = true;
    }),
  );
  if (IncusApi.OperationWaitResult.$is("Running")(result)) {
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

const shutdownExec = Effect.fn("IncusExecSession.shutdownExec")(function* (
  api: IncusApi.Interface,
  project: string,
  operation: IncusApi.OperationRef,
  lifecycle: ExecLifecycle,
) {
  if (lifecycle.terminal || !lifecycle.control) return;

  yield* lifecycle.control
    .write(JSON.stringify({ command: "signal", signal: 15 }))
    .pipe(
      Effect.timeout("250 millis"),
      Effect.ignore({ log: "Warn", message: "Failed to send SIGTERM to Incus exec" }),
    );
  // Bounded by the wait endpoint's own timeout. Anything still running when the socket scope
  // closes is killed by Incus when the control websocket goes away.
  yield* api.operations
    .wait(operation.id, { project, timeoutSeconds: 2, failureMode: "return" })
    .pipe(Effect.ignore);
});

export const exec = Effect.fn("IncusExecSession.exec")(function* (
  name: string,
  project: string,
  api: IncusApi.Interface,
  command: readonly string[],
  options?: IncusContainer.ExecOptions,
) {
  const timeoutSeconds = options?.timeoutSeconds;
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)) {
    return yield* new IncusContainer.ExecInvalidOptionsError({
      message: `Invalid timeoutSeconds: ${timeoutSeconds}. Must be a positive integer.`,
    });
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const lifecycle: ExecLifecycle = { control: undefined, terminal: false };
      const socketScope = yield* Effect.acquireRelease(Scope.make(), Scope.close);
      const operation = yield* api.instances.exec(
        name,
        execPayload(command, options),
        { project },
        (operation) =>
          shutdownExec(api, project, operation, lifecycle).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Incus exec shutdown failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
      );
      const secrets = yield* decodeExecWebSocketSecrets(operation);
      const connect = Effect.fnUntraced(function* (secret: string) {
        const socket = yield* api.operations.makeWebSocket(operation.id, secret, {
          openTimeout: 5000,
        });
        const reader = yield* Scope.provide(socket.reader, socketScope);
        return { socket, reader };
      });

      const control = yield* connect(secrets.control);
      lifecycle.control = yield* Scope.provide(control.socket.writer, socketScope);
      const { stdin, stdout, stderr } = yield* Effect.all(
        {
          stdin: connect(secrets["0"]),
          stdout: connect(secrets["1"]),
          stderr: connect(secrets["2"]),
        },
        { concurrency: "unbounded" },
      );
      const writer = yield* Scope.provide(stdin.socket.writer, socketScope);

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
});

export * as IncusExecSession from "./incus-exec-session.ts";
