import { NodeSocket } from "@effect/platform-node";
import { Cause, Data, Effect, Exit, Fiber, Option, Schema, Scope } from "effect";
import * as net from "node:net";
import * as Socket from "effect/unstable/socket/Socket";

import { IncusApiOperationError, type IncusApiService, type OperationWaitResult } from "./api.ts";
import type { IncusConfigService } from "./config.ts";
import type { IncusOperationsService } from "./operations.ts";

const SIGTERM = 15;
const SIGKILL = 9;

export class IncusContainerExecCallbackError extends Data.TaggedError(
  "IncusContainerExecCallbackError",
)<{
  readonly cause: unknown;
}> {}

export class IncusContainerExecInvalidOptionsError extends Data.TaggedError(
  "IncusContainerExecInvalidOptionsError",
)<{
  readonly message: string;
}> {}

export class IncusContainerExecTransportError extends Data.TaggedError(
  "IncusContainerExecTransportError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class IncusContainerExecTimeoutError extends Data.TaggedError(
  "IncusContainerExecTimeoutError",
)<{
  readonly timeoutSeconds: number;
}> {}

export interface IncusExecOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
  readonly onStdout?: (chunk: Uint8Array) => void | Effect.Effect<void, unknown, never>;
  readonly onStderr?: (chunk: Uint8Array) => void | Effect.Effect<void, unknown, never>;
}

export interface IncusExecResult {
  readonly exitCode: number;
}

const ControlSignal = Schema.Struct({
  command: Schema.Literal("signal"),
  signal: Schema.Number,
});

const ControlSignalJson = Schema.fromJsonString(ControlSignal);

const WebSocketSetupTimeoutMs = 5_000;
const OutputDrainTimeoutSeconds = 5;

const ExecResultMetadata = Schema.Struct({
  return: Schema.Number,
});

const createWebSocket = (
  config: IncusConfigService,
  operationId: string,
  secret: string,
): Effect.Effect<globalThis.WebSocket, never, never> => {
  const baseUrl =
    config.endpoint.type === "unix"
      ? "ws://incus"
      : config.endpoint.baseUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws"));
  const url = `${baseUrl}/1.0/operations/${encodeURIComponent(operationId)}/websocket?secret=${encodeURIComponent(secret)}`;

  if (config.endpoint.type === "unix") {
    const socketPath = config.endpoint.socketPath;
    return Effect.sync(() => {
      return new NodeSocket.NodeWS.WebSocket(url, undefined, {
        createConnection: () => net.createConnection({ path: socketPath }),
      }) as unknown as globalThis.WebSocket;
    });
  }

  const endpoint = config.endpoint;
  return Effect.sync(() => {
    return new NodeSocket.NodeWS.WebSocket(url, undefined, {
      ca: endpoint.tls?.caCert,
      cert: endpoint.tls?.clientCert,
      key: endpoint.tls?.clientKey,
      rejectUnauthorized: endpoint.tls?.rejectUnauthorized,
    }) as unknown as globalThis.WebSocket;
  });
};

const makeSocket = (
  config: IncusConfigService,
  operationId: string,
  secret: string,
): Effect.Effect<Socket.Socket, never, never> =>
  Socket.fromWebSocket(
    Effect.acquireRelease(createWebSocket(config, operationId, secret), (ws) =>
      Effect.sync(() => ws.close(1000)),
    ),
    // Incus may close the exec websocket without a proper close frame after
    // the process exits, resulting in code 1005/1006. The exec outcome is
    // determined by the operation wait, not the close code.
    { closeCodeIsError: () => false, openTimeout: WebSocketSetupTimeoutMs },
  );

const runCallback = (
  callback: ((chunk: Uint8Array) => void | Effect.Effect<void, unknown, never>) | undefined,
  chunk: Uint8Array,
): Effect.Effect<void, IncusContainerExecCallbackError, never> => {
  if (!callback) return Effect.void;
  return Effect.try({
    try: () => callback(chunk),
    catch: (cause) => new IncusContainerExecCallbackError({ cause }),
  }).pipe(
    Effect.flatMap((result) => {
      if (Effect.isEffect(result)) {
        return result.pipe(
          Effect.mapError((cause) => new IncusContainerExecCallbackError({ cause })),
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
): Effect.Effect<void, E | IncusContainerExecTransportError, never> =>
  Fiber.join(fiber).pipe(
    Effect.asVoid,
    Effect.timeoutOption(`${OutputDrainTimeoutSeconds} seconds`),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.void
        : Effect.fail(
            new IncusContainerExecTransportError({
              message: "Timed out waiting for exec output websocket to drain",
            }),
          ),
    ),
  );

const enforceTimeout =
  (timeoutSeconds: number | undefined) =>
  (
    result: OperationWaitResult,
  ): Effect.Effect<OperationWaitResult, IncusContainerExecTimeoutError> => {
    if (result.status === "running" && timeoutSeconds !== undefined) {
      return Effect.fail(new IncusContainerExecTimeoutError({ timeoutSeconds }));
    }
    return Effect.succeed(result);
  };

const asExecWaitResult = (
  operationId: string,
  result: OperationWaitResult,
): Effect.Effect<IncusExecResult, IncusApiOperationError> => {
  if (result.status === "running") {
    return Effect.fail(
      new IncusApiOperationError({
        operation: operationId,
        message: "Incus exec operation is still running",
        metadata: result.metadata,
      }),
    );
  }

  return Schema.decodeUnknownEffect(ExecResultMetadata)(result.metadata).pipe(
    Effect.mapError(
      (cause) =>
        new IncusApiOperationError({
          operation: operationId,
          message: "Failed to decode Incus operation response",
          metadata: { cause, body: { metadata: result.metadata } },
        }),
    ),
    Effect.map((metadata) => ({ exitCode: metadata.return })),
  );
};

const execPayload = (command: readonly string[], options: IncusExecOptions | undefined) => ({
  command: [...command],
  interactive: false,
  "wait-for-websocket": true,
  cwd: options?.cwd,
  environment: options?.environment,
});

const makeExecSockets = (
  config: IncusConfigService,
  operation: {
    readonly id: string;
    readonly fds: {
      readonly stdout: string;
      readonly stderr: string;
      readonly stdin: string;
      readonly control: string;
    };
  },
) =>
  Effect.all(
    {
      stdout: makeSocket(config, operation.id, operation.fds.stdout),
      stderr: makeSocket(config, operation.id, operation.fds.stderr),
      stdin: makeSocket(config, operation.id, operation.fds.stdin),
      control: makeSocket(config, operation.id, operation.fds.control),
    },
    { concurrency: "unbounded" },
  );

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

const makeControlWriter = (
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
  operations: IncusOperationsService,
  operationId: string,
  project: string,
  timeoutSeconds: number | undefined,
) =>
  // Incus reports exec exit 127 as operation failure; preserve metadata so callers get output and exit code.
  operations.wait(operationId, { project, timeoutSeconds, failureMode: "return" }).pipe(
    Effect.flatMap(enforceTimeout(timeoutSeconds)),
    Effect.flatMap((result) => asExecWaitResult(operationId, result)),
  );

const controlSignal = (signal: number) =>
  Schema.encodeEffect(ControlSignalJson)({ command: "signal", signal }).pipe(Effect.orDie);

const terminateExec = (
  operations: IncusOperationsService,
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
    const wait = yield* Effect.exit(operations.wait(operationId, { project, timeoutSeconds: 2 }));
    if (Exit.isSuccess(wait) && wait.value.status === "success") return;

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

export const execStream = Effect.fn("IncusContainer.execStream")(function* (
  name: string,
  project: string,
  api: IncusApiService,
  operations: IncusOperationsService,
  config: IncusConfigService,
  command: readonly string[],
  options?: IncusExecOptions,
) {
  if (
    options?.timeoutSeconds !== undefined &&
    (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0)
  ) {
    return yield* new IncusContainerExecInvalidOptionsError({
      message: `Invalid timeoutSeconds: ${options.timeoutSeconds}. Must be a positive integer.`,
    });
  }

  const operation = yield* api.instances.exec(name, execPayload(command, options), { project });

  return yield* Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const sockets = yield* makeExecSockets(config, operation);
    const commandTimeoutSeconds = options?.timeoutSeconds;

    const stdinFiber = yield* startStdin(sockets.stdin, scope);
    const stdoutFiber = yield* startOutput(sockets.stdout, options?.onStdout, scope);
    const stderrFiber = yield* startOutput(sockets.stderr, options?.onStderr, scope);
    const controlFiber = yield* sockets.control.runRaw(() => {}).pipe(Effect.forkIn(scope));
    const writeControl = yield* makeControlWriter(sockets.control, controlFiber, scope);

    const awaitOutput = Effect.all([drainOutputFiber(stdoutFiber), drainOutputFiber(stderrFiber)], {
      concurrency: "unbounded",
    });
    const outputFailure = Effect.raceFirst(
      failWhenFiberFails(stdoutFiber),
      failWhenFiberFails(stderrFiber),
    );

    const main = Effect.raceFirst(
      waitExecResult(operations, operation.id, project, commandTimeoutSeconds),
      outputFailure,
    ).pipe(
      Effect.tap(() => awaitOutput),
      Effect.onExit(() => Fiber.interrupt(stdinFiber).pipe(Effect.asVoid)),
    );

    return yield* main.pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? terminateExec(operations, operation.id, project, writeControl)
          : Effect.void,
      ),
      Effect.catchIf(
        (error): error is Socket.SocketError => error instanceof Socket.SocketError,
        (error) =>
          Effect.fail(
            new IncusContainerExecTransportError({
              message: `Websocket error: ${error.message}`,
              cause: error,
            }),
          ),
      ),
    );
  }).pipe(scopedPreservingBodyExit("incus-exec"));
});
