import { type Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Effect, Schema } from "effect";

export class DurableError extends Schema.TaggedError<DurableError>()("DurableError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const durableError = (cause: unknown) =>
  new DurableError({ message: "pi-durable operation failed.", cause });

export const tryDurablePromise = <A>(
  evaluate: (context: Context) => PromiseLike<A>,
): Effect.Effect<A, DurableError> =>
  Effect.tryPromise({
    try: (signal) => evaluate(withAbortSignal(signal, BACKGROUND_CONTEXT)),
    catch: durableError,
  });
