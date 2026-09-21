import { Routes, type GuildTextBasedChannel } from "discord.js";
import { Cause, Effect, FiberHandle, Schedule, Scope } from "effect";

import { tryDiscordJsPromise } from "./utils.ts";

export interface TypingIndicator {
  readonly activate: Effect.Effect<void>;
  readonly deactivate: Effect.Effect<void>;
}

interface CreateTypingIndicatorInput {
  readonly channel: GuildTextBasedChannel;
}

const SEND_TYPING_TIMEOUT_MS = 3000;
const TYPING_INDICATOR_PULSE_INTERVAL_MS = 7000;

export const createTypingIndicator = (
  input: CreateTypingIndicatorInput,
): Effect.Effect<TypingIndicator, never, Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* FiberHandle.make<void>();

    const sendTyping = tryDiscordJsPromise((signal) =>
      input.channel.client.rest.post(Routes.channelTyping(input.channel.id), { signal }),
    ).pipe(
      Effect.timeout(SEND_TYPING_TIMEOUT_MS),
      Effect.onError((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Typing indicator send failed", cause),
      ),
      Effect.annotateLogs({ channelId: input.channel.id }),
      Effect.withSpan("TypingIndicator.sendTyping", {
        root: true,
        attributes: { channelId: input.channel.id },
      }),
      Effect.ignore(),
    );

    const run = sendTyping.pipe(
      Effect.repeat(Schedule.fixed(TYPING_INDICATOR_PULSE_INTERVAL_MS)),
      Effect.asVoid,
    );

    const activate = FiberHandle.run(handle, run, { onlyIfMissing: true }).pipe(Effect.asVoid);

    const deactivate = FiberHandle.clear(handle);

    return {
      activate,
      deactivate,
    };
  });
