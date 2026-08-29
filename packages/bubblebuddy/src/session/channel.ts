import type { GuildTextBasedChannel, Message } from "discord.js";
import { Effect, Option, Ref, Schema, Scope, ScopedRef, Semaphore } from "effect";

import { formatMessageForPrompt } from "../discord/prompt-formatting.ts";
import type {
  PiSessionHandle,
  PiSessionModelInfo,
  PiSessionOpenOptions,
  SessionStats,
} from "../pi/session.ts";
import type { PromptTemplateContext } from "../pi/system-prompt.ts";
import { ChannelStateRepository } from "./state.ts";

type SessionParameters = {
  readonly channel: GuildTextBasedChannel;
  readonly promptContext: PromptTemplateContext;
};

export type ActivationParameters = SessionParameters & {
  readonly originMessage: Message<true>;
};

export type CompactionParameters = SessionParameters & {
  readonly customInstructions?: string;
};

export type AbortResult = "aborted" | "idle";
export type CompactResult = "done" | "no-session" | "rejected-busy" | "rejected-compacting";
export type DiscardResult = "discarded" | "rejected-busy";

export interface ChannelStatus {
  readonly model: PiSessionModelInfo | undefined;
  readonly showThinking: boolean;
  readonly stats: SessionStats;
}

export class ChannelSessionError extends Schema.TaggedError<ChannelSessionError>()(
  "ChannelSessionError",
  {
    channelId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface ChannelSession {
  readonly abort: Effect.Effect<AbortResult, ChannelSessionError>;
  readonly activate: (input: ActivationParameters) => Effect.Effect<void, ChannelSessionError>;
  readonly compact: (
    input: CompactionParameters,
  ) => Effect.Effect<CompactResult, ChannelSessionError>;
  readonly discard: Effect.Effect<DiscardResult, ChannelSessionError>;
  readonly status: (input: SessionParameters) => Effect.Effect<ChannelStatus, ChannelSessionError>;
  readonly toggleShowThinking: Effect.Effect<boolean, ChannelSessionError>;
}

interface ChannelSessionOptions {
  readonly channelId: string;
  readonly retain: Effect.Effect<void, never, Scope.Scope>;
  readonly openPiSession: (
    options: PiSessionOpenOptions,
  ) => Effect.Effect<PiSessionHandle, unknown, Scope.Scope>;
}

export const makeChannelSession = (options: ChannelSessionOptions) =>
  Effect.gen(function* () {
    const repository = yield* ChannelStateRepository;
    const lock = yield* Semaphore.make(1);
    const mapError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new ChannelSessionError({ channelId: options.channelId, cause }),
        ),
      );
    const activeSessionRef = yield* Ref.make(
      yield* mapError(repository.getActiveSession(options.channelId)),
    );
    const showThinkingRef = yield* Ref.make(
      yield* mapError(repository.getShowThinking(options.channelId)),
    );
    const piRef = yield* ScopedRef.make<PiSessionHandle | undefined>(() => undefined);

    const getShowThinking = () => Ref.getUnsafe(showThinkingRef);

    const setShowThinking = (value: boolean) =>
      Effect.gen(function* () {
        yield* mapError(repository.setShowThinking(options.channelId, value));
        yield* Ref.set(showThinkingRef, value);
      });

    const setActiveSession = (value: string) =>
      Effect.gen(function* () {
        yield* mapError(repository.setActiveSession(options.channelId, value));
        yield* Ref.set(activeSessionRef, value);
      });

    const clearActiveSession = () =>
      Effect.gen(function* () {
        yield* mapError(repository.clearActiveSession(options.channelId));
        yield* Ref.set(activeSessionRef, undefined);
      });

    const getOrCreatePiSession = (input: SessionParameters) =>
      Effect.gen(function* () {
        const current = yield* ScopedRef.get(piRef);
        if (current !== undefined) return current;

        const activeSession = yield* Ref.get(activeSessionRef);
        yield* mapError(
          ScopedRef.set(
            piRef,
            options.openPiSession({
              ...input,
              activeSession,
              getShowThinking,
              retainChannelSession: options.retain,
            }),
          ),
        );
        const pi = yield* ScopedRef.get(piRef);
        if (pi === undefined) {
          return yield* Effect.die("Pi session acquisition produced no session");
        }

        const activeSessionName = pi.getActiveSessionName();
        if (activeSessionName !== undefined && activeSessionName !== activeSession) {
          yield* setActiveSession(activeSessionName);
        }
        return pi;
      });

    const abort = Effect.gen(function* () {
      const pi = yield* ScopedRef.get(piRef);
      if (pi === undefined || !(pi.isCompacting() || pi.isStreaming() || pi.isRetrying())) {
        return "idle" as const;
      }

      yield* mapError(pi.abort);
      return "aborted" as const;
    });

    const activate = (input: ActivationParameters) =>
      lock.withPermit(
        Effect.gen(function* () {
          const pi = yield* getOrCreatePiSession(input);
          yield* mapError(
            pi.activate(formatMessageForPrompt(input.originMessage), input.originMessage.id),
          );
        }),
      );

    const compact = (input: CompactionParameters) => {
      const pi = ScopedRef.getUnsafe(piRef);
      if (pi?.isCompacting()) return Effect.succeed("rejected-compacting" as const);
      if (pi?.isStreaming() || pi?.isRetrying()) return Effect.succeed("rejected-busy" as const);

      return lock
        .withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            const currentPi = yield* ScopedRef.get(piRef);
            if (currentPi?.isCompacting()) return "rejected-compacting" as const;
            if (currentPi?.isStreaming() || currentPi?.isRetrying()) {
              return "rejected-busy" as const;
            }

            const activeSession = yield* Ref.get(activeSessionRef);
            if (currentPi === undefined && activeSession === undefined)
              return "no-session" as const;

            const session = yield* getOrCreatePiSession(input);
            yield* mapError(session.requestCompaction(input.customInstructions)).pipe(
              Effect.ignore({ log: "Warn", message: "Session compaction failed" }),
            );
            return "done" as const;
          }),
        )
        .pipe(Effect.map(Option.getOrElse(() => "rejected-busy" as const)));
    };

    const discard = lock
      .withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          const pi = yield* ScopedRef.get(piRef);
          if (pi?.isStreaming() || pi?.isCompacting() || pi?.isRetrying()) {
            return "rejected-busy" as const;
          }

          yield* ScopedRef.set(piRef, Effect.succeed(undefined));
          yield* clearActiveSession();
          return "discarded" as const;
        }),
      )
      .pipe(Effect.map(Option.getOrElse(() => "rejected-busy" as const)));

    const status = (input: SessionParameters) =>
      lock.withPermit(
        Effect.gen(function* () {
          const pi = yield* getOrCreatePiSession(input);
          return {
            model: pi.getModelInfo(),
            showThinking: yield* Ref.get(showThinkingRef),
            stats: pi.getSessionStats(),
          };
        }),
      );

    const toggleShowThinking = lock.withPermit(
      Effect.gen(function* () {
        const value = !(yield* Ref.get(showThinkingRef));
        yield* setShowThinking(value);
        return value;
      }),
    );

    return {
      abort,
      activate,
      compact,
      discard,
      status,
      toggleShowThinking,
    } satisfies ChannelSession;
  });
