import { Cause, Effect, Exit, Fiber, Option, Schema, Scope } from "effect";
import * as Socket from "effect/unstable/socket/Socket";

import { IncusApi } from "./incus-api.ts";
import { IncusContainer } from "./incus-container.ts";

const SIGTERM = 15;
const SIGKILL = 9;

const ControlSignal = Schema.Struct({
  command: Schema.Literal("signal"),
  signal: Schema.Int,
});

const ControlSignalJson = Schema.fromJsonString(ControlSignal);

const WebSocketSetupTimeoutMs = 5_000;
const OutputDrainTimeoutSeconds = 5;

const ExecResultMetadata = Schema.Struct({
  return: Schema.Int,
});

const ExecWebSocketSecrets = Schema.Struct({
  "0": Schema.String,
  "1": Schema.String,
  "2": Schema.String,
  control: Schema.String,
});
type ExecWebSocketSecrets = typeof ExecWebSocketSecrets.Type;

const runCallback = (
  callback: ((chunk: Uint8Array) => void | Effect.Effect<void, unknown, never>) | undefined,
  chunk: Uint8Array,
): Effect.Effect<void, IncusContainer.ExecCallbackError, never> => {
  if (!callback) return Effect.void;
  return Effect.try({
    try: () => callback(chunk),
    catch: (cause) => new IncusContainer.ExecCallbackError({ cause }),
  }).pipe(
    Effect.flatMap((result) => {
      if (Effect.isEffect(result)) {
        return result.pipe(
          Effect.mapError((cause) => new IncusContainer.ExecCallbackError({ cause })),
        );
      }
      return Effect.void;
    }),
  );
};

const failWhenFiberFails = <A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<never, E, never> =>
  Fiber.join(fiber).pipe(Effect.flatMap(() => Effect.never));

const drainOutputFiber = <A, E>(
  fiber: Fiber.Fiber<A, E>,
): Effect.Effect<void, E | IncusContainer.ExecTransportError, never> =>
  Fiber.join(fiber).pipe(
    Effect.asVoid,
    Effect.timeoutOption(`${OutputDrainTimeoutSeconds} seconds`),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.void
        : Effect.fail(
            new IncusContainer.ExecTransportError({
              message: "Timed out waiting for exec output websocket to drain",
            }),
          ),
    ),
  );

const enforceTimeout =
  (timeoutSeconds: number | undefined) =>
  (
    result: IncusApi.OperationWaitResult,
  ): Effect.Effect<IncusApi.OperationWaitResult, IncusContainer.ExecTimeoutError> => {
    if (result.status === "running" && timeoutSeconds !== undefined) {
      return Effect.fail(new IncusContainer.ExecTimeoutError({ timeoutSeconds }));
    }
    return Effect.succeed(result);
  };

const asExecWaitResult = (
  operationId: string,
  result: IncusApi.OperationWaitResult,
): Effect.Effect<IncusContainer.ExecResult, IncusApi.OperationError> => {
  if (result.status === "running") {
    return Effect.fail(
      new IncusApi.OperationError({
        operation: operationId,
        message: "Incus exec operation is still running",
        metadata: result.metadata,
      }),
    );
  }

  return Schema.decodeUnknownEffect(ExecResultMetadata)(result.metadata).pipe(
    Effect.mapError(
      (cause) =>
        new IncusApi.OperationError({
          operation: operationId,
          message: "Failed to decode Incus operation response",
          metadata: { cause, body: { metadata: result.metadata } },
        }),
    ),
    Effect.map((metadata) => ({ exitCode: metadata.return })),
  );
};

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

const createExecSockets = (
  api: IncusApi.Interface,
  operationId: string,
  secrets: ExecWebSocketSecrets,
) =>
  Effect.all(
    {
      stdout: api.operations.makeWebSocket(operationId, secrets["1"], execWebSocketOptions),
      stderr: api.operations.makeWebSocket(operationId, secrets["2"], execWebSocketOptions),
      stdin: api.operations.makeWebSocket(operationId, secrets["0"], execWebSocketOptions),
      control: api.operations.makeWebSocket(operationId, secrets.control, execWebSocketOptions),
    },
    { concurrency: "unbounded" },
  );

const execWebSocketOptions = {
  // Incus may close the exec websocket without a proper close frame after
  // the process exits. The exec outcome is determined by the operation wait.
  closeCodeIsError: () => false,
  openTimeout: WebSocketSetupTimeoutMs,
};

const startStdin = (stdinSocket: Socket.Socket, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const stdinWriter = yield* Scope.provide(stdinSocket.writer, scope);
    // Stdin is not exposed by this API yet, so close it immediately. This lets commands
    // waiting for EOF, such as `cat`, exit instead of hanging forever.
    return yield* stdinSocket
      .runRaw(() => {}, {
        onOpen: stdinWriter(new Socket.CloseEvent(1000, "stdin unsupported")).pipe(Effect.ignore),
      })
      .pipe(Effect.forkIn(scope));
  });

const startOutput = (
  socket: Socket.Socket,
  callback: ((chunk: Uint8Array) => void | Effect.Effect<void, unknown, never>) | undefined,
  scope: Scope.Scope,
) => socket.run((chunk) => runCallback(callback, chunk)).pipe(Effect.forkIn(scope));

const createControlWriter = (
  controlSocket: Socket.Socket,
  controlFiber: Fiber.Fiber<void, Socket.SocketError>,
  scope: Scope.Scope,
) =>
  Effect.gen(function* () {
    const controlWriter = yield* Scope.provide(controlSocket.writer, scope);
    return (chunk: Uint8Array | string) =>
      controlWriter(chunk).pipe(Effect.raceFirst(Fiber.await(controlFiber).pipe(Effect.asVoid)));
  });

const waitExecResult = (
  api: IncusApi.Interface,
  operationId: string,
  project: string,
  timeoutSeconds: number | undefined,
) =>
  // Incus reports exec exit 127 as operation failure; preserve metadata so callers get output and exit code.
  api.operations.wait(operationId, { project, timeoutSeconds, failureMode: "return" }).pipe(
    Effect.flatMap(enforceTimeout(timeoutSeconds)),
    Effect.flatMap((result) => asExecWaitResult(operationId, result)),
  );

const controlSignal = (signal: number) =>
  Schema.encodeEffect(ControlSignalJson)({ command: "signal", signal }).pipe(Effect.orDie);

const terminateExec = (
  api: IncusApi.Interface,
  operationId: string,
  project: string,
  writeControl: (chunk: Uint8Array | string) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    yield* controlSignal(SIGTERM).pipe(
      Effect.flatMap((sigterm) => writeControl(sigterm)),
      Effect.timeout("250 millis"),
      Effect.ignore,
    );

    // Give process a chance to exit gracefully
    const waitResult = yield* Effect.exit(
      api.operations.wait(operationId, { project, timeoutSeconds: 2 }),
    );
    if (Exit.isSuccess(waitResult) && waitResult.value.status === "success") return;

    yield* controlSignal(SIGKILL).pipe(
      Effect.flatMap((sigkill) => writeControl(sigkill)),
      Effect.timeout("250 millis"),
      Effect.ignore,
    );
  });

const scopedPreservingBodyExit =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const bodyExit = yield* effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.exit);
      yield* Scope.close(scope, Exit.void).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`${label} teardown errored; preserving body result`, {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      return yield* bodyExit;
    }) as Effect.Effect<A, E, Exclude<R, Scope.Scope>>;

export const exec = Effect.fn("IncusExecSession.exec")(function* (
  name: string,
  project: string,
  api: IncusApi.Interface,
  command: readonly string[],
  options?: IncusContainer.ExecOptions,
) {
  if (
    options?.timeoutSeconds !== undefined &&
    (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0)
  ) {
    return yield* new IncusContainer.ExecInvalidOptionsError({
      message: `Invalid timeoutSeconds: ${options.timeoutSeconds}. Must be a positive integer.`,
    });
  }

  const operation = yield* api.instances.exec(name, execPayload(command, options), { project });

  return yield* Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const secrets = yield* decodeExecWebSocketSecrets(operation).pipe(
      Effect.onError(() =>
        api.operations.cancel(operation.id, { project }).pipe(
          Effect.ignore({
            log: "Warn",
            message: "Failed to cancel Incus exec after invalid websocket secrets",
          }),
        ),
      ),
    );
    const sockets = yield* createExecSockets(api, operation.id, secrets);
    const commandTimeoutSeconds = options?.timeoutSeconds;

    const stdinFiber = yield* startStdin(sockets.stdin, scope);
    const stdoutFiber = yield* startOutput(sockets.stdout, options?.onStdout, scope);
    const stderrFiber = yield* startOutput(sockets.stderr, options?.onStderr, scope);
    const controlFiber = yield* sockets.control.runRaw(() => {}).pipe(Effect.forkIn(scope));
    const writeControl = yield* createControlWriter(sockets.control, controlFiber, scope);

    const awaitOutput = Effect.all([drainOutputFiber(stdoutFiber), drainOutputFiber(stderrFiber)], {
      concurrency: "unbounded",
    });
    const outputFailure = Effect.raceFirst(
      failWhenFiberFails(stdoutFiber),
      failWhenFiberFails(stderrFiber),
    );

    const main = Effect.raceFirst(
      waitExecResult(api, operation.id, project, commandTimeoutSeconds),
      outputFailure,
    ).pipe(
      Effect.tap(() => awaitOutput),
      Effect.onExit(() => Fiber.interrupt(stdinFiber).pipe(Effect.asVoid)),
    );

    return yield* main.pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? terminateExec(api, operation.id, project, writeControl)
          : Effect.void,
      ),
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
  }).pipe(scopedPreservingBodyExit("incus-exec"));
});

export * as IncusExecSession from "./incus-exec-session.ts";
