import { basename } from "node:path";

import type { GuildTextBasedChannel, Message } from "discord.js";
import { Data, Effect, Option, Ref, Scope, Semaphore } from "effect";

import {
  ChannelStateRepository,
  type ChannelStateRepositoryError,
} from "./channel-state-repository.ts";
import { formatMessageForPrompt } from "./discord/message-formatting.ts";
import type { PromptTemplateContext } from "./domain/prompt.ts";
import type { ChannelSessionOperationError, ScopedPiChannelSession } from "./pi/channel-session.ts";
import { PiChannelSessionFactory } from "./pi/channel-session-factory.ts";
import type { SessionKeepAliveFactory } from "./session-keep-alive.ts";

export type CreateSessionParams = {
  channel: GuildTextBasedChannel;
  promptContext: PromptTemplateContext;
};

export type ActivationParams = CreateSessionParams & {
  originMessage: Message<true>;
};

export type CompactionParams = CreateSessionParams & {
  customInstructions?: string;
};

export type CompactResult = "done" | "no-session" | "rejected-busy" | "rejected-compacting";

export type DiscardResult = "discarded" | "rejected-busy";

export class ChannelRuntimeOperationError extends Data.TaggedError("ChannelRuntimeOperationError")<{
  readonly channelId: string;
  readonly operation: "session";
  readonly cause: unknown;
}> {}

export type ChannelRuntimeError =
  | ChannelStateRepositoryError
  | ChannelRuntimeOperationError
  | ChannelSessionOperationError;

export interface ChannelRuntime {
  readonly activate: (
    input: ActivationParams,
  ) => Effect.Effect<void, ChannelRuntimeError, Scope.Scope>;
  readonly compact: (
    input: CompactionParams,
  ) => Effect.Effect<CompactResult, ChannelRuntimeError, Scope.Scope>;
  readonly discardPiSession: () => Effect.Effect<DiscardResult, ChannelRuntimeError, Scope.Scope>;
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
  ChannelStateRepositoryError,
  ChannelStateRepository | PiChannelSessionFactory | Scope.Scope
> =>
  Effect.gen(function* () {
    const repository = yield* ChannelStateRepository;
    const sessionFactory = yield* PiChannelSessionFactory;
    const lock = yield* Semaphore.make(1);
    const activeSessionRef = yield* Ref.make(yield* repository.getActiveSession(options.channelId));
    const showThinkingRef = yield* Ref.make(yield* repository.getShowThinking(options.channelId));
    const piRef = yield* Ref.make<ScopedPiChannelSession | undefined>(undefined);

    const getShowThinking = () => Ref.getUnsafe(showThinkingRef);
    const setShowThinking = (value: boolean) =>
      Effect.gen(function* () {
        yield* repository.setShowThinking(options.channelId, value);
        yield* Ref.set(showThinkingRef, value);
      });
    const setActiveSession = (value: string) =>
      Effect.gen(function* () {
        yield* repository.setActiveSession(options.channelId, value);
        yield* Ref.set(activeSessionRef, value);
      });
    const clearActiveSession = () =>
      Effect.gen(function* () {
        yield* repository.clearActiveSession(options.channelId);
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
      input: CreateSessionParams,
    ): Effect.Effect<ScopedPiChannelSession, ChannelRuntimeError, Scope.Scope> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(piRef);
        if (current !== undefined) {
          return current;
        }

        const created = yield* sessionFactory
          .create(input, options.makeKeepAlive, getShowThinking)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ChannelRuntimeOperationError({
                  channelId: input.channel.id,
                  operation: "session",
                  cause,
                }),
            ),
          );
        yield* Ref.set(piRef, created.pi);

        const sessionFile = created.sessionManager.getSessionFile();
        if (sessionFile !== undefined) {
          const newActiveSession = basename(sessionFile);
          const activeSession = yield* Ref.get(activeSessionRef);
          if (activeSession !== newActiveSession) {
            yield* setActiveSession(newActiveSession);
          }
        }

        return created.pi;
      });

    const activate = (
      input: ActivationParams,
    ): Effect.Effect<void, ChannelRuntimeError, Scope.Scope> =>
      lock.withPermit(
        Effect.gen(function* () {
          const session = yield* getOrCreatePi(input);
          yield* session.session.activate(
            formatMessageForPrompt(input.originMessage),
            input.originMessage.id,
          );
        }),
      );

    const compact = (
      input: CompactionParams,
    ): Effect.Effect<CompactResult, ChannelRuntimeError, Scope.Scope> => {
      const pi = Ref.getUnsafe(piRef);
      if (pi?.session.isCompacting) {
        return Effect.succeed("rejected-compacting");
      }
      if (pi?.session.isStreaming || pi?.session.isRetrying) {
        return Effect.succeed("rejected-busy");
      }

      return lock
        .withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            // Best-effort guard for auto-compaction edge cases; lock races may still report busy.
            const currentPi = yield* Ref.get(piRef);
            if (currentPi?.session.isCompacting) {
              return "rejected-compacting";
            }
            if (currentPi?.session.isStreaming || currentPi?.session.isRetrying) {
              return "rejected-busy";
            }
            const activeSession = yield* Ref.get(activeSessionRef);
            if (currentPi === undefined && activeSession === undefined) {
              return "no-session";
            }

            const session = yield* getOrCreatePi(input);
            yield* session.session
              .requestCompaction(input.customInstructions)
              .pipe(Effect.ignore({ log: "Warn", message: "Session compaction failed" }));
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
            if (pi?.session.isStreaming || pi?.session.isCompacting || pi?.session.isRetrying) {
              return "rejected-busy" as const;
            }

            yield* closeAndClearPi();

            yield* clearActiveSession();
            return "discarded" as const;
          }),
        )
        .pipe(Effect.map(Option.getOrElse(() => "rejected-busy" as const)));

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
      toggleShowThinking,
    };
  });
