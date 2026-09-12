import { Routes, type GuildTextBasedChannel } from "discord.js";
import {
  Context,
  Effect,
  Option,
  Ref,
  Schema,
  Scope,
  ScopedRef,
  Semaphore,
  SynchronizedRef,
  Tracer,
} from "effect";

import { createDiscordOutputPump } from "../discord/session-output-pump.ts";
import { tryDiscordJsPromise } from "../discord/utils.ts";
import {
  createPiSession,
  type PiSessionHandle,
  type PiSessionModelInfo,
  type PiSessionServices,
  type SessionStats,
} from "../pi/session.ts";
import { ChannelStateRepository } from "./state.ts";

export interface ActivateChannelSessionInput {
  readonly channel: GuildTextBasedChannel;
  readonly prompt: string;
}

export interface CompactChannelSessionInput {
  readonly channel: GuildTextBasedChannel;
  readonly customInstructions?: string;
}

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
    channel: GuildTextBasedChannel,
  ) => Effect.Effect<ChannelStatus, ChannelSessionError>;
  readonly toggleShowThinking: Effect.Effect<boolean, ChannelSessionError>;
}

interface CreateChannelSessionInput {
  readonly channelId: string;
  readonly retain: Effect.Effect<void, never, Scope.Scope>;
}

export const createChannelSession = (input: CreateChannelSessionInput) =>
  Effect.gen(function* () {
    const attributes = { channelId: input.channelId };
    const repository = yield* ChannelStateRepository;
    // Re-provided at Pi session creation, so drop ParentSpan to keep the invocation's parent.
    const piServices = Context.omit(Tracer.ParentSpan)(yield* Effect.context<PiSessionServices>());
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

    const clearActiveSession = Effect.gen(function* () {
      yield* repository.clearActiveSession(input.channelId).pipe(mapToChannelSessionError);
      yield* Ref.set(activeSessionRef, undefined);
    }).pipe(
      Effect.annotateLogs(attributes),
      Effect.withSpan("ChannelSession.clearActiveSession", { attributes }),
    );

    const getOrCreatePiSession = Effect.fn("ChannelSession.getOrCreatePiSession", { attributes })(
      function* (channel: GuildTextBasedChannel) {
        const current = yield* ScopedRef.get(piRef);
        if (current !== undefined) return current;

        const activeSession = yield* Ref.get(activeSessionRef);
        yield* ScopedRef.set(
          piRef,
          Effect.gen(function* () {
            const output = yield* createDiscordOutputPump({
              channel,
              showThinking: SynchronizedRef.get(showThinkingRef),
            });
            const pi = yield* createPiSession({
              channel,
              activeSession,
              output,
            });
            const activeSessionName = pi.getActiveSessionName();
            if (activeSessionName !== undefined && activeSessionName !== activeSession) {
              yield* repository.setActiveSession(input.channelId, activeSessionName);
              yield* Ref.set(activeSessionRef, activeSessionName);
            }
            return pi;
          }),
        ).pipe(Effect.provide(piServices), mapToChannelSessionError);
        const pi = yield* ScopedRef.get(piRef);
        if (pi === undefined) {
          return yield* Effect.die(new Error("Pi session acquisition produced no session"));
        }

        return pi;
      },
      Effect.annotateLogs(attributes),
    );

    const abort = Effect.gen(function* () {
      const pi = yield* ScopedRef.get(piRef);
      if (pi === undefined || !(pi.isCompacting() || pi.isStreaming() || pi.isRetrying())) {
        return "idle" as const;
      }

      yield* pi.abort.pipe(mapToChannelSessionError);
      return "aborted" as const;
    }).pipe(
      Effect.annotateLogs(attributes),
      Effect.withSpan("ChannelSession.abort", { attributes }),
    );

    const activate = Effect.fn("ChannelSession.activate", { attributes })(function* (
      activation: ActivateChannelSessionInput,
    ) {
      const pi = yield* ScopedRef.get(piRef);
      if (pi === undefined || !(pi.isStreaming() || pi.isRetrying() || pi.isCompacting())) {
        yield* tryDiscordJsPromise((signal) =>
          activation.channel.client.rest.post(Routes.channelTyping(activation.channel.id), {
            signal,
          }),
        ).pipe(
          Effect.timeout("3 seconds"),
          Effect.ignore({
            log: "Warn",
            message: "Eager typing indicator send failed",
          }),
          Effect.forkDetach({ startImmediately: true }),
        );
      }

      yield* lock.withPermit(
        Effect.gen(function* () {
          const pi = yield* getOrCreatePiSession(activation.channel);
          yield* pi
            .activate({
              prompt: activation.prompt,
              retainChannelSession: input.retain,
            })
            .pipe(mapToChannelSessionError);
        }),
      );
    }, Effect.annotateLogs(attributes));

    const compact = Effect.fn("ChannelSession.compact", { attributes })(function* (
      compaction: CompactChannelSessionInput,
    ) {
      const pi = ScopedRef.getUnsafe(piRef);
      if (pi?.isCompacting()) return "rejected-compacting" as const;
      if (pi?.isStreaming() || pi?.isRetrying()) return "rejected-busy" as const;

      return yield* lock
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

            const session = yield* getOrCreatePiSession(compaction.channel);
            yield* session.requestCompaction(compaction.customInstructions).pipe(Effect.ignore);
            return "done" as const;
          }),
        )
        .pipe(Effect.map(Option.getOrElse(() => "rejected-busy" as const)));
    }, Effect.annotateLogs(attributes));

    const discard = lock
      .withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          const pi = yield* ScopedRef.get(piRef);
          if (pi?.isStreaming() || pi?.isCompacting() || pi?.isRetrying()) {
            return "rejected-busy" as const;
          }

          // @effect-diagnostics-next-line effectSucceedWithVoid:off
          yield* ScopedRef.set(piRef, Effect.succeed(undefined));
          yield* clearActiveSession;
          return "discarded" as const;
        }),
      )
      .pipe(
        Effect.map(Option.getOrElse(() => "rejected-busy" as const)),
        Effect.annotateLogs(attributes),
        Effect.withSpan("ChannelSession.discard", { attributes }),
      );

    const status = Effect.fn("ChannelSession.status", { attributes })(function* (
      channel: GuildTextBasedChannel,
    ) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const pi = yield* getOrCreatePiSession(channel);
          return {
            model: pi.getModelInfo(),
            showThinking: yield* SynchronizedRef.get(showThinkingRef),
            stats: pi.getSessionStats(),
          };
        }),
      );
    }, Effect.annotateLogs(attributes));

    const toggleShowThinking = SynchronizedRef.updateAndGetEffect(showThinkingRef, (current) =>
      Effect.gen(function* () {
        const next = !current;
        yield* repository.setShowThinking(input.channelId, next).pipe(mapToChannelSessionError);
        return next;
      }),
    ).pipe(
      Effect.annotateLogs(attributes),
      Effect.withSpan("ChannelSession.toggleShowThinking", { attributes }),
    );

    return {
      abort,
      activate,
      compact,
      discard,
      status,
      toggleShowThinking,
    } satisfies ChannelSession;
  }).pipe(
    // Construction-scoped only; the returned operations carry their own attributes.
    Effect.annotateLogs({ channelId: input.channelId }),
    Effect.annotateSpans({ channelId: input.channelId }),
  );
