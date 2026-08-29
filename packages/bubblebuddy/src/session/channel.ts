import type { GuildTextBasedChannel, Message } from "discord.js";
import { Effect, Option, Ref, Schema, Scope, ScopedRef, Semaphore, SynchronizedRef } from "effect";

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
    const mapToChannelSessionError = Effect.mapError(
      (cause) => new ChannelSessionError({ channelId: input.channelId, cause }),
    );
    const activeSessionRef = yield* Ref.make(
      yield* repository.getActiveSession(input.channelId).pipe(mapToChannelSessionError),
    );
    const showThinkingRef = yield* SynchronizedRef.make(
      yield* repository.getShowThinking(input.channelId).pipe(mapToChannelSessionError),
    );
    const piRef = yield* ScopedRef.make<PiSessionHandle | undefined>(() => undefined);

    const setActiveSession = (value: string) =>
      Effect.gen(function* () {
        yield* repository.setActiveSession(input.channelId, value).pipe(mapToChannelSessionError);
        yield* Ref.set(activeSessionRef, value);
      });

    const clearActiveSession = () =>
      Effect.gen(function* () {
        yield* repository.clearActiveSession(input.channelId).pipe(mapToChannelSessionError);
        yield* Ref.set(activeSessionRef, undefined);
      });

    const getOrCreatePiSession = (context: ChannelSessionContext) =>
      Effect.gen(function* () {
        const current = yield* ScopedRef.get(piRef);
        if (current !== undefined) return current;

        const activeSession = yield* Ref.get(activeSessionRef);
        yield* ScopedRef.set(
          piRef,
          Effect.gen(function* () {
            const output = yield* createDiscordOutputPump({
              channel: context.channel,
              showThinking: SynchronizedRef.get(showThinkingRef),
            });
            return yield* createPiSession({ ...context, activeSession, output }).pipe(
              Effect.provide(piServices),
            );
          }),
        ).pipe(mapToChannelSessionError);
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

      yield* pi.abort.pipe(mapToChannelSessionError);
      return "aborted" as const;
    });

    const activate = (activation: ActivateChannelSessionInput) =>
      lock.withPermit(
        Effect.gen(function* () {
          const pi = yield* getOrCreatePiSession(activation);
          yield* pi
            .activate({
              prompt: formatMessageForPrompt(activation.originMessage),
              replyToMessageId: activation.originMessage.id,
              retainChannelSession: input.retain,
            })
            .pipe(mapToChannelSessionError);
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
            yield* session
              .requestCompaction(compaction.customInstructions)
              .pipe(
                mapToChannelSessionError,
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

          // @effect-diagnostics-next-line effectSucceedWithVoid:off
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
            showThinking: yield* SynchronizedRef.get(showThinkingRef),
            stats: pi.getSessionStats(),
          };
        }),
      );

    const toggleShowThinking = SynchronizedRef.updateAndGetEffect(showThinkingRef, (current) =>
      Effect.gen(function* () {
        const next = !current;
        yield* repository.setShowThinking(input.channelId, next).pipe(mapToChannelSessionError);
        return next;
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
