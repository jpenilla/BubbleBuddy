import type { GuildTextBasedChannel, Message } from "discord.js";
import { Effect, Option, Ref, Schema, Scope, ScopedRef, Semaphore } from "effect";

import { formatMessageForPrompt } from "../discord/prompt-formatting.ts";
import { createDiscordOutputPump } from "../discord/session-output-pump.ts";
import {
  createPiSession,
  type PiSessionHandle,
  type PiSessionModelInfo,
  type PiSessionServices,
  type SessionStats,
} from "../pi/session.ts";
import type { PromptTemplateContext } from "../pi/system-prompt.ts";
import { ChannelStateRepository } from "./state.ts";

interface ChannelSessionContext {
  readonly channel: GuildTextBasedChannel;
  readonly promptContext: PromptTemplateContext;
}

export type ActivateChannelSessionInput = ChannelSessionContext & {
  readonly originMessage: Message<true>;
};

export type CompactChannelSessionInput = ChannelSessionContext & {
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
  readonly activate: (
    input: ActivateChannelSessionInput,
  ) => Effect.Effect<void, ChannelSessionError>;
  readonly compact: (
    input: CompactChannelSessionInput,
  ) => Effect.Effect<CompactResult, ChannelSessionError>;
  readonly discard: Effect.Effect<DiscardResult, ChannelSessionError>;
  readonly status: (
    context: ChannelSessionContext,
  ) => Effect.Effect<ChannelStatus, ChannelSessionError>;
  readonly toggleShowThinking: Effect.Effect<boolean, ChannelSessionError>;
}

interface CreateChannelSessionInput {
  readonly channelId: string;
  readonly retain: Effect.Effect<void, never, Scope.Scope>;
}

export const createChannelSession = (input: CreateChannelSessionInput) =>
  Effect.gen(function* () {
    const repository = yield* ChannelStateRepository;
    const piServices = yield* Effect.context<PiSessionServices>();
    const lock = yield* Semaphore.make(1);
    const mapError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => new ChannelSessionError({ channelId: input.channelId, cause })),
      );
    const activeSessionRef = yield* Ref.make(
      yield* mapError(repository.getActiveSession(input.channelId)),
    );
    const showThinkingRef = yield* Ref.make(
      yield* mapError(repository.getShowThinking(input.channelId)),
    );
    const piRef = yield* ScopedRef.make<PiSessionHandle | undefined>(() => undefined);

    const setShowThinking = (value: boolean) =>
      Effect.gen(function* () {
        yield* mapError(repository.setShowThinking(input.channelId, value));
        yield* Ref.set(showThinkingRef, value);
      });

    const setActiveSession = (value: string) =>
      Effect.gen(function* () {
        yield* mapError(repository.setActiveSession(input.channelId, value));
        yield* Ref.set(activeSessionRef, value);
      });

    const clearActiveSession = () =>
      Effect.gen(function* () {
        yield* mapError(repository.clearActiveSession(input.channelId));
        yield* Ref.set(activeSessionRef, undefined);
      });

    const getOrCreatePiSession = (context: ChannelSessionContext) =>
      Effect.gen(function* () {
        const current = yield* ScopedRef.get(piRef);
        if (current !== undefined) return current;

        const activeSession = yield* Ref.get(activeSessionRef);
        yield* mapError(
          ScopedRef.set(
            piRef,
            Effect.gen(function* () {
              const output = yield* createDiscordOutputPump({
                channel: context.channel,
                showThinking: Ref.get(showThinkingRef),
              });
              return yield* createPiSession({ ...context, activeSession, output }).pipe(
                Effect.provide(piServices),
              );
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

    const activate = (activation: ActivateChannelSessionInput) =>
      lock.withPermit(
        Effect.gen(function* () {
          const pi = yield* getOrCreatePiSession(activation);
          yield* mapError(
            pi.activate({
              prompt: formatMessageForPrompt(activation.originMessage),
              replyToMessageId: activation.originMessage.id,
              retainChannelSession: input.retain,
            }),
          );
        }),
      );

    const compact = (compaction: CompactChannelSessionInput) => {
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

            const session = yield* getOrCreatePiSession(compaction);
            yield* mapError(session.requestCompaction(compaction.customInstructions)).pipe(
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

    const status = (context: ChannelSessionContext) =>
      lock.withPermit(
        Effect.gen(function* () {
          const pi = yield* getOrCreatePiSession(context);
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
