import { Routes, type GuildTextBasedChannel } from "discord.js";
import { Clock, Data, Deferred, Effect, Queue, Scope } from "effect";

import { tryDiscordJsPromise } from "./utils.ts";

export interface TypingIndicator {
  readonly activate: Effect.Effect<void>;
  readonly deactivate: Effect.Effect<void>;
  readonly messageSent: Effect.Effect<void>;
}

interface CreateTypingIndicatorInput {
  readonly channel: GuildTextBasedChannel;
}

type TypingCommand = Data.TaggedEnum<{
  Activate: {};
  Deactivate: { readonly completed: Deferred.Deferred<void> };
  MessageSent: {};
  Tick: {};
}>;

const TypingCommand = Data.taggedEnum<TypingCommand>();

const SEND_TYPING_TIMEOUT_MS = 3000;
const TYPING_INDICATOR_PULSE_INTERVAL_MS = 7000;

export const createTypingIndicator = (
  input: CreateTypingIndicatorInput,
): Effect.Effect<TypingIndicator, never, Scope.Scope> =>
  Effect.gen(function* () {
    const commands = yield* Effect.acquireRelease(Queue.unbounded<TypingCommand>(), Queue.shutdown);

    const sendTyping = tryDiscordJsPromise((signal) =>
      input.channel.client.rest.post(Routes.channelTyping(input.channel.id), { signal }),
    ).pipe(
      Effect.timeout(SEND_TYPING_TIMEOUT_MS),
      Effect.withSpan("TypingIndicator.sendTyping"),
      Effect.ignore({
        log: "Warn",
        message: `Failed to send typing indicator for channel ${input.channel.id}`,
      }),
    );

    const run = Effect.gen(function* () {
      let active = false;
      let nextPulseAt = 0;

      const pulse = Effect.gen(function* () {
        nextPulseAt = (yield* Clock.currentTimeMillis) + TYPING_INDICATOR_PULSE_INTERVAL_MS;
        yield* sendTyping;
      });

      const waitForTick = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, nextPulseAt - now));
        return TypingCommand.Tick();
      });

      const processCommand = TypingCommand.$match({
        Activate: () =>
          Effect.gen(function* () {
            active = true;
            yield* pulse;
          }),
        Deactivate: ({ completed }) =>
          Effect.gen(function* () {
            active = false;
            yield* Deferred.succeed(completed, undefined);
          }),
        MessageSent: () =>
          Effect.gen(function* () {
            if (active) {
              yield* pulse;
            }
          }),
        Tick: () => pulse,
      });

      while (true) {
        const command = active
          ? yield* Effect.race(Queue.take(commands), waitForTick)
          : yield* Queue.take(commands);
        yield* processCommand(command);
      }
    });

    yield* Effect.forkScoped(run);

    const activate = Queue.offer(commands, TypingCommand.Activate()).pipe(
      Effect.asVoid,
      Effect.withSpan("TypingIndicator.activate"),
    );

    const deactivate = Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      yield* Queue.offer(commands, TypingCommand.Deactivate({ completed }));
      yield* Deferred.await(completed);
    }).pipe(Effect.withSpan("TypingIndicator.deactivate"));

    const messageSent = Queue.offer(commands, TypingCommand.MessageSent()).pipe(
      Effect.asVoid,
      Effect.withSpan("TypingIndicator.messageSent"),
    );

    return {
      activate,
      deactivate,
      messageSent,
    };
  });
