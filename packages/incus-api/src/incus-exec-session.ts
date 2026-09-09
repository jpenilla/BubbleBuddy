import { Cause, Deferred, Effect, Exit, Fiber, Queue, Schema, Scope } from "effect";
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
const encodeControlSignalJson = Schema.encodeEffect(ControlSignalJson);

const controlSignal = (signal: number) =>
  encodeControlSignalJson({ command: "signal", signal }).pipe(Effect.orDie);

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

type ControlWriter = (chunk: Uint8Array | string) => Effect.Effect<void, unknown>;

interface ExecLifecycle {
  writeControl: ControlWriter | undefined;
  terminal: boolean;
}

interface SocketRunner {
  readonly ready: Deferred.Deferred<void, Socket.SocketError>;
  readonly fiber: Fiber.Fiber<void, Socket.SocketError>;
}

const OutputEnd = Symbol("IncusExecOutputEnd");
type OutputItem = Uint8Array | typeof OutputEnd;

const runCallback = Effect.fnUntraced(function* (
  callback: ((chunk: Uint8Array) => void | Effect.Effect<void, unknown, never>) | undefined,
  chunk: Uint8Array,
) {
  if (!callback) return;
  const result = yield* Effect.try({
    try: () => callback(chunk),
    catch: (cause) => new IncusContainer.ExecCallbackError({ cause }),
  });
  if (Effect.isEffect(result)) {
    yield* result.pipe(Effect.mapError((cause) => new IncusContainer.ExecCallbackError({ cause })));
  }
});

const failWhenFiberFails = <A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<never, E, never> =>
  Fiber.join(fiber).pipe(Effect.flatMap(() => Effect.never));

const socketRunnerOpenError = (name: string) =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({
      kind: "Unknown",
      cause: new Error(`${name} websocket runner exited before opening`),
    }),
  });

const socketRunnerUnavailableError = (name: string) =>
  new Socket.SocketError({
    reason: new Socket.SocketCloseError({
      code: 1006,
      closeReason: `${name} websocket runner is unavailable`,
    }),
  });

const startSocketRunner = Effect.fnUntraced(function* (
  name: string,
  run: (onOpen: Effect.Effect<void>) => Effect.Effect<void, Socket.SocketError>,
  scope: Scope.Scope,
) {
  const ready = yield* Deferred.make<void, Socket.SocketError>();
  const onOpen = Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
  const fiber = yield* run(onOpen).pipe(
    // onOpen and onExit race to complete readiness, so a runner cannot leave setup waiting forever.
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Deferred.fail(ready, socketRunnerOpenError(name)).pipe(Effect.asVoid)
        : Deferred.failCause(ready, exit.cause).pipe(Effect.asVoid),
    ),
    Effect.forkIn(scope),
  );
  return { ready, fiber };
});

const awaitSocketRunnerReady = (runner: SocketRunner) => Deferred.await(runner.ready);

const startOutputConsumer = Effect.fnUntraced(function* (
  callback: ((chunk: Uint8Array) => void | Effect.Effect<void, unknown, never>) | undefined,
  scope: Scope.Scope,
) {
  // Callbacks are ordered per stream; buffering is intentionally unbounded.
  const queue = yield* Scope.provide(
    Effect.acquireRelease(Queue.unbounded<OutputItem>(), Queue.shutdown),
    scope,
  );
  const fiber = yield* Effect.gen(function* () {
    while (true) {
      const item = yield* Queue.take(queue);
      if (item === OutputEnd) return;
      yield* runCallback(callback, item);
    }
  }).pipe(Effect.forkIn(scope));
  return { queue, fiber };
});

const drainOutputCallbacks = <A, E>(
  fibers: readonly Fiber.Fiber<A, E>[],
): Effect.Effect<void, E | IncusContainer.ExecTransportError, never> =>
  Effect.forEach(fibers, (fiber) => Fiber.join(fiber), {
    concurrency: "unbounded",
    discard: true,
  }).pipe(
    Effect.timeoutOrElse({
      duration: `${OutputDrainTimeoutSeconds} seconds`,
      orElse: () =>
        Effect.fail(
          new IncusContainer.ExecTransportError({
            message: "Timed out waiting for exec output callbacks to drain",
          }),
        ),
    }),
  );

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

const makeExecSockets = (
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

const startStdin = Effect.fn("IncusExecSession.startStdin")(function* (
  stdinSocket: Socket.Socket,
  scope: Scope.Scope,
) {
  const stdinWriter = yield* Scope.provide(stdinSocket.writer, scope);
  const runner = yield* startSocketRunner(
    "stdin",
    (onOpen) => stdinSocket.runRaw(() => {}, { onOpen }),
    scope,
  );
  yield* awaitSocketRunnerReady(runner);
  // Stdin is not exposed by this API yet, so close it immediately. This lets commands
  // waiting for EOF, such as `cat`, exit instead of hanging forever.
  yield* stdinWriter(new Socket.CloseEvent(1000, "stdin unsupported"));
  return runner;
});

const startOutput = (
  name: string,
  socket: Socket.Socket,
  queue: Queue.Queue<OutputItem>,
  scope: Scope.Scope,
): Effect.Effect<SocketRunner> =>
  startSocketRunner(
    name,
    (onOpen) =>
      socket
        .run(
          (chunk) => {
            Queue.offerUnsafe(queue, chunk);
          },
          { onOpen },
        )
        .pipe(
          Effect.tap(() =>
            Queue.offer(queue, OutputEnd).pipe(
              Effect.flatMap((enqueued) =>
                enqueued ? Effect.void : Effect.fail(socketRunnerUnavailableError(name)),
              ),
            ),
          ),
        ),
    scope,
  );

const createControlWriter = Effect.fnUntraced(function* (
  controlSocket: Socket.Socket,
  controlRunner: SocketRunner,
  scope: Scope.Scope,
) {
  const controlWriter = yield* Scope.provide(controlSocket.writer, scope);
  return (chunk: Uint8Array | string) =>
    Effect.raceFirst(
      controlWriter(chunk),
      Fiber.join(controlRunner.fiber).pipe(
        Effect.andThen(Effect.fail(socketRunnerUnavailableError("control"))),
      ),
    );
});

const waitExecResult = Effect.fn("IncusExecSession.waitExecResult")(function* (
  api: IncusApi.Interface,
  operationId: string,
  project: string,
  timeoutSeconds: number | undefined,
  lifecycle: ExecLifecycle,
) {
  // Incus reports exec exit 127 as operation failure; preserve metadata so callers get output and exit code.
  const result = yield* api.operations.wait(operationId, {
    project,
    timeoutSeconds,
    failureMode: "return",
  });
  yield* Effect.uninterruptible(
    Effect.sync(() => {
      if (result.status !== "running") lifecycle.terminal = true;
    }),
  );
  if (result.status === "running") {
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
  if (lifecycle.terminal) return;

  const writeControl = lifecycle.writeControl;
  if (!writeControl) {
    yield* api.operations
      .cancel(operation.id, { project })
      .pipe(
        Effect.timeout("250 millis"),
        Effect.ignore({ log: "Warn", message: "Failed to cancel Incus exec during cleanup" }),
      );
    return;
  }

  const sendSignal = (signal: number) =>
    controlSignal(signal).pipe(
      Effect.flatMap(writeControl),
      Effect.timeout("250 millis"),
      Effect.ignore({
        log: "Warn",
        message: `Failed to send signal ${signal} to Incus exec during cleanup`,
      }),
    );

  yield* sendSignal(SIGTERM);

  // Give process a chance to exit gracefully
  const waitResult = yield* Effect.exit(
    api.operations.wait(operation.id, { project, timeoutSeconds: 2, failureMode: "return" }),
  );
  if (Exit.isSuccess(waitResult) && waitResult.value.status !== "running") {
    lifecycle.terminal = true;
    return;
  }
  if (Exit.isFailure(waitResult)) {
    yield* Effect.logWarning("Failed waiting for Incus exec shutdown; sending SIGKILL", {
      cause: Cause.pretty(waitResult.cause),
    });
  }

  yield* sendSignal(SIGKILL);
});

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

  const lifecycle: ExecLifecycle = {
    writeControl: undefined,
    terminal: false,
  };

  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Registered first so it closes last: operation cleanup still needs the control socket.
      const socketScope = yield* Effect.acquireRelease(Scope.make(), Scope.close);
      const operation = yield* api.instances.exec(
        name,
        execPayload(command, options),
        { project },
        (operation) =>
          shutdownExec(api, project, operation, lifecycle).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Incus exec shutdown failed; preserving body result", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
      );
      const secrets = yield* decodeExecWebSocketSecrets(operation);
      const sockets = yield* makeExecSockets(api, operation.id, secrets);
      const commandTimeoutSeconds = options?.timeoutSeconds;

      const controlRunner = yield* startSocketRunner(
        "control",
        (onOpen) => sockets.control.runRaw(() => {}, { onOpen }),
        socketScope,
      );
      yield* awaitSocketRunnerReady(controlRunner);
      const writeControl = yield* createControlWriter(sockets.control, controlRunner, socketScope);
      lifecycle.writeControl = writeControl;
      const stdoutConsumer = yield* startOutputConsumer(options?.onStdout, socketScope);
      const stderrConsumer = yield* startOutputConsumer(options?.onStderr, socketScope);

      const runners = yield* Effect.all(
        {
          stdin: startStdin(sockets.stdin, socketScope),
          stdout: startOutput("stdout", sockets.stdout, stdoutConsumer.queue, socketScope),
          stderr: startOutput("stderr", sockets.stderr, stderrConsumer.queue, socketScope),
        },
        { concurrency: "unbounded" },
      );
      const executionFailure = Effect.raceAllFirst([
        failWhenFiberFails(controlRunner.fiber),
        failWhenFiberFails(runners.stdin.fiber),
        failWhenFiberFails(runners.stdout.fiber),
        failWhenFiberFails(runners.stderr.fiber),
        failWhenFiberFails(stdoutConsumer.fiber),
        failWhenFiberFails(stderrConsumer.fiber),
      ]);
      const allReady = Effect.all(
        [awaitSocketRunnerReady(runners.stdout), awaitSocketRunnerReady(runners.stderr)],
        { concurrency: "unbounded" },
      );
      yield* Effect.raceFirst(allReady, executionFailure);

      const awaitCallbacks = drainOutputCallbacks([stdoutConsumer.fiber, stderrConsumer.fiber]);
      const main = Effect.raceFirst(
        waitExecResult(api, operation.id, project, commandTimeoutSeconds, lifecycle),
        executionFailure,
      ).pipe(
        Effect.tap(() => Effect.raceFirst(awaitCallbacks, executionFailure)),
        Effect.onExit(() => Fiber.interrupt(runners.stdin.fiber).pipe(Effect.asVoid)),
      );

      return yield* main;
    }).pipe(
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
    ),
  );
});

export * as IncusExecSession from "./incus-exec-session.ts";
