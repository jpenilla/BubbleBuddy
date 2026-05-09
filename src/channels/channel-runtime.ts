import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { Data, Effect, Option, Ref, Scope, Semaphore } from "effect";

import { ChannelStateRepository } from "./state-repository.ts";
import { formatMessageForPrompt } from "../discord/message-formatting.ts";
import type { PromptTemplateContext } from "../prompt/system-prompt.ts";
import type { PiChannelSessionModelInfo, ScopedPiChannelSession } from "../pi-session/session.ts";
import { PiChannelSessionFactory } from "../pi-session/session-factory.ts";
import type { SessionKeepAliveFactory } from "./keep-alive.ts";

type RuntimeSessionParams = {
  channel: GuildTextBasedChannel;
  promptContext: PromptTemplateContext;
};

export type ActivationParams = RuntimeSessionParams & {
  originMessage: Message<true>;
};

export type CompactionParams = RuntimeSessionParams & {
  customInstructions?: string;
};

export type CompactResult = "done" | "no-session" | "rejected-busy" | "rejected-compacting";

export type DiscardResult = "discarded" | "rejected-busy";

export interface ChannelStatus {
  readonly model: PiChannelSessionModelInfo | undefined;
  readonly showThinking: boolean;
  readonly stats: SessionStats;
}

export class ChannelRuntimeError extends Data.TaggedError("ChannelRuntimeError")<{
  readonly channelId: string;
  readonly cause: unknown;
}> {}

export interface ChannelRuntime {
  readonly activate: (
    input: ActivationParams,
  ) => Effect.Effect<void, ChannelRuntimeError, Scope.Scope>;
  readonly compact: (
    input: CompactionParams,
  ) => Effect.Effect<CompactResult, ChannelRuntimeError, Scope.Scope>;
  readonly discardPiSession: () => Effect.Effect<DiscardResult, ChannelRuntimeError, Scope.Scope>;
  readonly status: (input: RuntimeSessionParams) => Effect.Effect<ChannelStatus, ChannelRuntimeError, Scope.Scope>;
  readonly toggleShowThinking: () => Effect.Effect<boolean, ChannelRuntimeError, Scope.Scope>;
}

export interface ChannelRuntimeOptions {
  readonly channelId: string;
  readonly makeKeepAlive: SessionKeepAliveFactory;
}

export const makeChannelRuntime = (
  options: ChannelRuntimeOptions,
): Effect.Effect<
  ChannelRuntime,
  ChannelRuntimeError,
  ChannelStateRepository | PiChannelSessionFactory | Scope.Scope
> =>
  Effect.gen(function* () {
    const repository = yield* ChannelStateRepository;
    const sessionFactory = yield* PiChannelSessionFactory;
    const lock = yield* Semaphore.make(1);
    const wrapRuntimeError = <E>() =>
      Effect.mapError(
        (cause: E) => new ChannelRuntimeError({ channelId: options.channelId, cause }),
      );
    const activeSessionRef = yield* Ref.make(
      yield* repository.getActiveSession(options.channelId).pipe(wrapRuntimeError()),
    );
    const showThinkingRef = yield* Ref.make(
      yield* repository.getShowThinking(options.channelId).pipe(wrapRuntimeError()),
    );
    const piRef = yield* Ref.make<ScopedPiChannelSession | undefined>(undefined);

    const getShowThinking = () => Ref.getUnsafe(showThinkingRef);
    const setShowThinking = (value: boolean) =>
      Effect.gen(function* () {
        yield* repository.setShowThinking(options.channelId, value).pipe(wrapRuntimeError());
        yield* Ref.set(showThinkingRef, value);
      });
    const setActiveSession = (value: string) =>
      Effect.gen(function* () {
        yield* repository.setActiveSession(options.channelId, value).pipe(wrapRuntimeError());
        yield* Ref.set(activeSessionRef, value);
      });
    const clearActiveSession = () =>
      Effect.gen(function* () {
        yield* repository.clearActiveSession(options.channelId).pipe(wrapRuntimeError());
        yield* Ref.set(activeSessionRef, undefined);
      });

    const closeAndClearPi = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const session = yield* Ref.getAndSet(piRef, undefined);
        if (session !== undefined) {
          yield* session.close;
        }
      });

    const getOrCreatePi = (
      input: RuntimeSessionParams,
    ): Effect.Effect<ScopedPiChannelSession, ChannelRuntimeError, Scope.Scope> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(piRef);
        if (current !== undefined) {
          return current;
        }

        const pi = yield* sessionFactory
          .create({
            ...input,
            channelId: options.channelId,
            getShowThinking,
            makeKeepAlive: options.makeKeepAlive,
          })
          .pipe(wrapRuntimeError());
        yield* Ref.set(piRef, pi);

        const activeSessionName = pi.getActiveSessionName();
        if (activeSessionName !== undefined) {
          const activeSession = yield* Ref.get(activeSessionRef);
          if (activeSession !== activeSessionName) {
            yield* setActiveSession(activeSessionName);
          }
        }

        return pi;
      });

    const activate = (
      input: ActivationParams,
    ): Effect.Effect<void, ChannelRuntimeError, Scope.Scope> =>
      lock.withPermit(
        Effect.gen(function* () {
          const session = yield* getOrCreatePi(input);
          yield* session
            .activate(formatMessageForPrompt(input.originMessage), input.originMessage.id)
            .pipe(wrapRuntimeError());
        }),
      );

    const compact = (
      input: CompactionParams,
    ): Effect.Effect<CompactResult, ChannelRuntimeError, Scope.Scope> => {
      const pi = Ref.getUnsafe(piRef);
      if (pi?.isCompacting()) {
        return Effect.succeed("rejected-compacting");
      }
      if (pi?.isStreaming() || pi?.isRetrying()) {
        return Effect.succeed("rejected-busy");
      }

      return lock
        .withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            // Best-effort guard for auto-compaction edge cases; lock races may still report busy.
            const currentPi = yield* Ref.get(piRef);
            if (currentPi?.isCompacting()) {
              return "rejected-compacting";
            }
            if (currentPi?.isStreaming() || currentPi?.isRetrying()) {
              return "rejected-busy";
            }
            const activeSession = yield* Ref.get(activeSessionRef);
            if (currentPi === undefined && activeSession === undefined) {
              return "no-session";
            }

            const session = yield* getOrCreatePi(input);
            yield* session
              .requestCompaction(input.customInstructions)
              .pipe(
                wrapRuntimeError(),
                Effect.ignore({ log: "Warn", message: "Session compaction failed" }),
              );
            return "done";
          }),
        )
        .pipe(Effect.map(Option.getOrElse(() => "rejected-busy" as const)));
    };

    const discardPiSession = (): Effect.Effect<DiscardResult, ChannelRuntimeError> =>
      lock
        .withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            const pi = yield* Ref.get(piRef);
            if (pi?.isStreaming() || pi?.isCompacting() || pi?.isRetrying()) {
              return "rejected-busy" as const;
            }

            yield* closeAndClearPi();

            yield* clearActiveSession();
            return "discarded" as const;
          }),
        )
        .pipe(Effect.map(Option.getOrElse(() => "rejected-busy" as const)));

    const status = (
      input: RuntimeSessionParams,
    ): Effect.Effect<ChannelStatus, ChannelRuntimeError, Scope.Scope> =>
      lock.withPermit(
        Effect.gen(function* () {
          const session = yield* getOrCreatePi(input);
          const showThinking = yield* Ref.get(showThinkingRef);
          return {
            model: session.getModelInfo(),
            showThinking,
            stats: session.getSessionStats(),
          };
        }),
      );

    const toggleShowThinking = (): Effect.Effect<boolean, ChannelRuntimeError> =>
      Effect.gen(function* () {
        const showThinking = yield* Ref.get(showThinkingRef);
        const value = !showThinking;
        yield* setShowThinking(value);
        return value;
      });

    yield* Effect.addFinalizer(() =>
      lock
        .withPermit(closeAndClearPi())
        .pipe(Effect.ignore({ log: "Error", message: "Runtime cleanup failed" })),
    );
    return {
      activate,
      compact,
      discardPiSession,
      status,
      toggleShowThinking,
    };
  });
