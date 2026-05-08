import type { GuildTextBasedChannel } from "discord.js";
import { Effect, FiberHandle, Option, Scope, TxQueue } from "effect";

export interface TypingIndicator {
  readonly start: Effect.Effect<void>;
  readonly awaitStop: Effect.Effect<void>;
  readonly refresh: Effect.Effect<void>;
}

interface TypingIndicatorOptions {
  readonly channel: GuildTextBasedChannel;
  readonly intervalMs: number;
}

const SEND_TYPING_TIMEOUT_MS = 1000;
const STOP_TYPING_TIMEOUT_MS = 1000;

export const makeTypingIndicator = (
  options: TypingIndicatorOptions,
): Effect.Effect<TypingIndicator, never, Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* FiberHandle.make<void, never>();
    const refreshSignals = yield* Effect.acquireRelease(TxQueue.sliding<void>(1), TxQueue.shutdown);

    const sendTyping = Effect.tryPromise(() => options.channel.sendTyping()).pipe(
      Effect.timeout(SEND_TYPING_TIMEOUT_MS),
      Effect.ignore({
        log: "Warn",
        message: `Failed to send typing indicator for channel ${options.channel.id}`,
      }),
    );

    const isActive = FiberHandle.get(handle).pipe(Effect.map(Option.isSome));

    const waitForRefresh = TxQueue.take(refreshSignals).pipe(Effect.tx, Effect.asVoid);

    const waitForNextRefresh = Effect.race(Effect.sleep(options.intervalMs), waitForRefresh);

    const loop = sendTyping.pipe(Effect.andThen(waitForNextRefresh), Effect.forever);

    const start = FiberHandle.run(handle, loop, { onlyIfMissing: true }).pipe(Effect.asVoid);

    const awaitStop = FiberHandle.clear(handle).pipe(
      Effect.timeout(STOP_TYPING_TIMEOUT_MS),
      Effect.ignore,
    );

    const refresh = Effect.gen(function* () {
      if (yield* isActive) {
        yield* TxQueue.offer(refreshSignals, undefined).pipe(Effect.tx, Effect.asVoid);
      }
    });

    return {
      start,
      awaitStop,
      refresh,
    };
  });
