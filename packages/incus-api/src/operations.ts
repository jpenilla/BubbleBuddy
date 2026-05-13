import { Cause, Context, Data, Effect, Exit, Layer } from "effect";

import {
  IncusApi,
  IncusApiTimeoutError,
  type IncusApiError,
  type OperationWaitResponse,
} from "./api.ts";

export interface IncusOperationWaitOptions {
  readonly project: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface IncusOperationsService {
  readonly wait: (
    operationId: string,
    options: IncusOperationWaitOptions,
  ) => Effect.Effect<OperationWaitResponse, IncusOperationsError>;
  readonly waitInterruptible: (
    operationId: string,
    options: IncusOperationWaitOptions,
  ) => Effect.Effect<OperationWaitResponse, IncusOperationsError>;
}

export type IncusOperationsError = IncusApiError | IncusOperationAbortError;

export class IncusOperationAbortError extends Data.TaggedError("IncusOperationAbortError")<{
  readonly operation: string;
  readonly reason: unknown;
}> {}

const make = Effect.gen(function* () {
  const api = yield* IncusApi;

  const wait = Effect.fn("IncusOperations.wait")(function* (
    operationId: string,
    options: IncusOperationWaitOptions,
  ) {
    const effect = api.operations.wait(operationId, {
      project: options.project,
      timeoutMs: options.timeoutMs,
    });
    const requestedTimeoutMs = options.timeoutMs;
    if (requestedTimeoutMs === undefined) return yield* effect;
    const clientTimeoutMs = requestedTimeoutMs + OperationWaitGraceMs;
    return yield* effect.pipe(
      Effect.timeout(clientTimeoutMs),
      Effect.mapError((error) =>
        Cause.isTimeoutError(error)
          ? new IncusApiTimeoutError({
              method: "GET",
              path: `/1.0/operations/${encodeURIComponent(operationId)}/wait`,
              requestedTimeoutMs,
              clientTimeoutMs,
            })
          : error,
      ),
    );
  });

  const cancel = (operationId: string, options: { readonly project: string }) =>
    api.operations.cancel(operationId, options);

  const waitInterruptible = Effect.fn("IncusOperations.waitInterruptible")(function* (
    operationId: string,
    options: IncusOperationWaitOptions,
  ) {
    const effect =
      options.signal === undefined
        ? wait(operationId, options)
        : Effect.raceFirst(
            wait(operationId, options),
            failWhenAborted(operationId, options.signal),
          );
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        shouldCancelOperation(exit)
          ? cancel(operationId, { project: options.project }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
  });

  return { wait, waitInterruptible };
});

export class IncusOperations extends Context.Service<IncusOperations, IncusOperationsService>()(
  "incus-api/IncusOperations",
) {
  static readonly layer = Layer.effect(IncusOperations, make);
}

const OperationWaitGraceMs = 5_000;

const failWhenAborted = (operationId: string, signal: AbortSignal) =>
  Effect.callback<never, IncusOperationAbortError, never>((resume) => {
    const abort = () =>
      Effect.fail(new IncusOperationAbortError({ operation: operationId, reason: signal.reason }));
    if (signal.aborted) {
      resume(abort());
      return;
    }
    const onAbort = () => resume(abort());
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const shouldCancelOperation = (exit: Exit.Exit<unknown, unknown>) =>
  exit._tag === "Failure" &&
  (Cause.hasInterrupts(exit.cause) || exit.cause.reasons.some(isOperationCancellationFailure));

const isOperationCancellationFailure = (reason: Cause.Reason<unknown>) =>
  Cause.isFailReason(reason) &&
  (Cause.isTimeoutError(reason.error) ||
    reason.error instanceof IncusApiTimeoutError ||
    reason.error instanceof IncusOperationAbortError);
