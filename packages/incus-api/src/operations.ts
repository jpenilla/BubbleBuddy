import { Cause, Context, Effect, Layer } from "effect";

import {
  IncusApi,
  IncusApiTimeoutError,
  type IncusApiError,
  type OperationWaitResult,
} from "./api.ts";

export interface IncusOperationWaitOptions {
  readonly project: string;
  readonly timeoutSeconds?: number;
  readonly failureMode?: "fail" | "return";
}

export interface IncusOperationsService {
  readonly wait: (
    operationId: string,
    options: IncusOperationWaitOptions,
  ) => Effect.Effect<OperationWaitResult, IncusOperationsError>;
}

export type IncusOperationsError = IncusApiError;

const make = Effect.gen(function* () {
  const api = yield* IncusApi;

  const withClientTimeout = <A>(
    operationId: string,
    options: IncusOperationWaitOptions,
    effect: Effect.Effect<A, IncusApiError>,
  ) => {
    const requestedTimeoutSeconds = options.timeoutSeconds;
    if (requestedTimeoutSeconds === undefined) return effect;
    const clientTimeoutSeconds = requestedTimeoutSeconds + OperationWaitGraceSeconds;
    return effect.pipe(
      Effect.timeout(`${clientTimeoutSeconds} seconds`),
      Effect.mapError((error) =>
        Cause.isTimeoutError(error)
          ? new IncusApiTimeoutError({
              method: "GET",
              path: `/1.0/operations/${encodeURIComponent(operationId)}/wait`,
              requestedTimeoutSeconds,
              clientTimeoutSeconds,
            })
          : error,
      ),
    );
  };

  const wait = Effect.fn("IncusOperations.wait")(function* (
    operationId: string,
    options: IncusOperationWaitOptions,
  ) {
    return yield* withClientTimeout(
      operationId,
      options,
      api.operations.wait(operationId, {
        project: options.project,
        timeoutSeconds: options.timeoutSeconds,
        failureMode: options.failureMode,
      }),
    );
  });

  return { wait };
});

export class IncusOperations extends Context.Service<IncusOperations, IncusOperationsService>()(
  "incus-api/IncusOperations",
) {
  static readonly layer = Layer.effect(IncusOperations, make);
}

const OperationWaitGraceSeconds = 5;
