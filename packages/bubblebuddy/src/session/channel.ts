import { type GuildTextBasedChannel } from "discord.js";
import {
  Context,
  Effect,
  Option,
  Ref,
  Schema,
  type Scope,
  ScopedRef,
  Semaphore,
  Tracer,
} from "effect";

import { OutputPump } from "../discord/output-pump.ts";
import { createRunErrorEmbed } from "../discord/run-status-embed.ts";
import { SessionOutput } from "../discord/session-output.ts";
import { sendMessage } from "../discord/utils.ts";
import { PiContext } from "../pi/context.ts";
import { DurableError, tryDurablePromise } from "../pi/durable.ts";
import {
  countMessages,
  readSessionStatus,
  type MessageCounts,
  type SessionStatus,
} from "../pi/session-status.ts";
import {
  createPiSession,
  type PiSession,
  PiSessionInitError,
  type PiSessionServices,
} from "../pi/session.ts";
import { ChannelSettings } from "./settings.ts";
import { ChannelStateRepository } from "./state-repository.ts";

export interface ActivateChannelSessionInput {
  readonly channel: GuildTextBasedChannel;
  readonly prompt: string;
}

export interface CompactChannelSessionInput {
  readonly channel: GuildTextBasedChannel;
  readonly customInstructions?: string;
}

export type AbortResult = "aborted" | "idle";
export type CompactResult = "requested" | "no-session";
export type DiscardResult = "discarded" | "rejected-busy";

export class ChannelSessionError extends Schema.TaggedError<ChannelSessionError>()(
  "ChannelSessionError",
  {
    channelId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface ChannelSession {
  readonly abort: (
    channel: GuildTextBasedChannel,
  ) => Effect.Effect<AbortResult, ChannelSessionError>;
  readonly activate: (
    input: ActivateChannelSessionInput,
  ) => Effect.Effect<void, ChannelSessionError>;
  /** Opens the session so its stored unfinished work continues. */
  readonly resume: (channel: GuildTextBasedChannel) => Effect.Effect<void, ChannelSessionError>;
  readonly compact: (
    input: CompactChannelSessionInput,
  ) => Effect.Effect<CompactResult, ChannelSessionError>;
  readonly discard: Effect.Effect<DiscardResult, ChannelSessionError>;
  readonly abortAndDiscard: Effect.Effect<void, ChannelSessionError>;
  readonly status: (
    channel: GuildTextBasedChannel,
  ) => Effect.Effect<SessionStatus, ChannelSessionError>;
  readonly messageCounts: (
    channel: GuildTextBasedChannel,
  ) => Effect.Effect<MessageCounts, ChannelSessionError>;
}

/** What the error card of a failed activation says. */
const describeActivationFailure = (cause: unknown): string => {
  if (cause instanceof PiSessionInitError) return cause.message;
  if (cause instanceof DurableError && cause.cause instanceof Error) return cause.cause.message;
  return "The session failed unexpectedly.";
};

interface CreateChannelSessionInput {
  readonly channelId: string;
  readonly retain: Effect.Effect<void, never, Scope.Scope>;
}

export const createChannelSession = (input: CreateChannelSessionInput) =>
  Effect.gen(function* () {
    const attributes = { channelId: input.channelId };
    const repository = yield* ChannelStateRepository.Service;
    const mapToChannelSessionError = Effect.mapError(
      (cause) => new ChannelSessionError({ channelId: input.channelId, cause }),
    );
    const settingsService = yield* ChannelSettings.Service;
    const settings = yield* settingsService.get(input.channelId).pipe(mapToChannelSessionError);
    // Re-provided at Pi session creation, so drop ParentSpan to keep the invocation's parent.
    const piServices = Context.omit(Tracer.ParentSpan)(yield* Effect.context<PiSessionServices>());
    const piContext = yield* PiContext;
    // Serializes opening and discarding the Pi session, and admitting work so a discard sees it; pi-durable orders
    // everything else.
    const lock = yield* Semaphore.make(1);
    const activeSessionRef = yield* Ref.make(
      yield* repository.getActiveSession(input.channelId).pipe(mapToChannelSessionError),
    );
    const piRef = yield* ScopedRef.make<PiSession | undefined>(() => undefined);

    /** The conversation's unfinished tasks and submissions. */
    const inspectWork = (pi: PiSession) =>
      tryDurablePromise((context) => pi.harness.inspect(context)).pipe(
        Effect.map((inspection) => ({
          tasks: inspection.tasks.filter(
            ({ record }) => record.conversationId === pi.conversation.id,
          ),
          submissions: inspection.submissions.filter(
            (submission) => submission.conversationId === pi.conversation.id,
          ),
        })),
        mapToChannelSessionError,
      );

    const closeSession = Effect.gen(function* () {
      // @effect-diagnostics-next-line effectSucceedWithVoid:off
      yield* ScopedRef.set(piRef, Effect.succeed(undefined));
      yield* repository.clearActiveSession(input.channelId).pipe(mapToChannelSessionError);
      yield* Ref.set(activeSessionRef, undefined);
    }).pipe(Effect.withSpan("ChannelSession.closeSession", { attributes }));

    const openSession = Effect.fn("ChannelSession.openSession", { attributes })(function* (
      channel: GuildTextBasedChannel,
    ) {
      const current = yield* ScopedRef.get(piRef);
      if (current !== undefined) return current;

      const activeSession = yield* Ref.get(activeSessionRef);
      yield* ScopedRef.set(
        piRef,
        Effect.gen(function* () {
          const pump = yield* OutputPump.create(channel);
          const handleSessionEvent = yield* SessionOutput.create({
            channel,
            pump,
            showThinking: settings.getShowThinking,
          });
          const pi = yield* createPiSession({
            channel,
            activeSession,
            pump,
            handleSessionEvent,
            retainChannelSession: input.retain,
          });
          if (pi.sessionName !== activeSession) {
            yield* repository.setActiveSession(input.channelId, pi.sessionName);
            yield* Ref.set(activeSessionRef, pi.sessionName);
          }
          // Marked before any new work is admitted, and cleared only by a close that leaves no unfinished work, so a
          // crash keeps it.
          yield* repository.setResume(input.channelId, true);
          // Runs before the harness closes.
          yield* Effect.addFinalizer(() =>
            inspectWork(pi).pipe(
              Effect.flatMap(({ tasks, submissions }) =>
                repository.setResume(input.channelId, tasks.length > 0 || submissions.length > 0),
              ),
              Effect.ignore({
                log: "Warn",
                message: "Failed to record whether the session has unfinished work",
              }),
            ),
          );
          return pi;
        }),
      ).pipe(Effect.provide(piServices), mapToChannelSessionError);
      const pi = yield* ScopedRef.get(piRef);
      if (pi === undefined) {
        return yield* Effect.die(new Error("Pi session acquisition produced no session"));
      }
      return pi;
    });

    /** Whether the channel has a session, open or stored. */
    const hasSession = Effect.gen(function* () {
      const current = yield* ScopedRef.get(piRef);
      const activeSession = yield* Ref.get(activeSessionRef);
      return current !== undefined || activeSession !== undefined;
    });

    /** An open session needs no lock; opening one waits for other operations. */
    const getOrOpenSession = Effect.fnUntraced(function* (channel: GuildTextBasedChannel) {
      const current = yield* ScopedRef.get(piRef);
      if (current !== undefined) return current;
      return yield* lock.withPermit(openSession(channel));
    });

    /** Whether the conversation has live work that `abort` stops: everything but background tasks. */
    const hasWork = (pi: PiSession) =>
      inspectWork(pi).pipe(
        Effect.map(({ tasks }) => tasks.some(({ record }) => !record.background)),
      );

    /** Withdraw queued input and stop all work, background work included, before the session closes. */
    const abortAll = (pi: PiSession) =>
      tryDurablePromise((context) => pi.conversation.abort(context, { background: true })).pipe(
        mapToChannelSessionError,
      );

    const abort = Effect.fn("ChannelSession.abort", { attributes })(function* (
      channel: GuildTextBasedChannel,
    ) {
      let pi = yield* ScopedRef.get(piRef);
      if (pi === undefined) {
        // Startup may not have resumed the session's unfinished work yet. Opening does not start that work, so it is
        // aborted before it runs.
        const resumable = yield* repository
          .getResume(input.channelId)
          .pipe(mapToChannelSessionError);
        if (!resumable) return "idle" as const;
        pi = yield* lock.withPermit(openSession(channel));
      }
      if (!(yield* hasWork(pi))) return "idle" as const;
      const conversation = pi.conversation;
      yield* tryDurablePromise((context) => conversation.abort(context)).pipe(
        mapToChannelSessionError,
      );
      return "aborted" as const;
    }, Effect.annotateLogs(attributes));

    const activate = Effect.fn("ChannelSession.activate", { attributes })(
      function* (activation: ActivateChannelSessionInput) {
        const pi = yield* openSession(activation.channel);
        yield* tryDurablePromise((context) =>
          pi.conversation.submit(
            { type: "input", content: activation.prompt, whenBusy: "steer" },
            context,
          ),
        ).pipe(mapToChannelSessionError);
        yield* pi.retainUntilIdle;
      },
      (effect) => lock.withPermit(effect),
      // Reported straight to the channel: the session, and with it the output pump, may have failed to open.
      (effect, activation) =>
        effect.pipe(
          Effect.tapError((error) =>
            sendMessage(activation.channel, {
              embeds: [createRunErrorEmbed(describeActivationFailure(error.cause))],
            }).pipe(Effect.ignore({ log: "Warn", message: "Failed to report activation failure" })),
          ),
        ),
      Effect.annotateLogs(attributes),
    );

    const resume = Effect.fn("ChannelSession.resume", { attributes })(
      function* (channel: GuildTextBasedChannel) {
        // Discarded since startup listed it.
        if (!(yield* hasSession)) return;
        const pi = yield* openSession(channel);
        // Waiting for idle also starts the stored work.
        yield* pi.retainUntilIdle;
      },
      (effect) => lock.withPermit(effect),
      Effect.annotateLogs(attributes),
    );

    const compact = Effect.fn("ChannelSession.compact", { attributes })(
      function* (compaction: CompactChannelSessionInput) {
        if (!(yield* hasSession)) {
          return "no-session" as const;
        }
        const pi = yield* openSession(compaction.channel);
        yield* tryDurablePromise((context) =>
          pi.conversation.compact(compaction.customInstructions, context),
        ).pipe(mapToChannelSessionError);
        yield* pi.retainUntilIdle;
        return "requested" as const;
      },
      (effect) => lock.withPermit(effect),
      Effect.annotateLogs(attributes),
    );

    const discard = lock
      .withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          const pi = yield* ScopedRef.get(piRef);
          if (pi !== undefined) {
            if (yield* hasWork(pi)) return "rejected-busy" as const;
            // Background work belongs to the session being discarded.
            yield* abortAll(pi);
          }
          yield* closeSession;
          return "discarded" as const;
        }),
      )
      .pipe(
        Effect.map(Option.getOrElse(() => "rejected-busy" as const)),
        Effect.annotateLogs(attributes),
        Effect.withSpan("ChannelSession.discard", { attributes }),
      );

    const abortAndDiscard = lock
      .withPermit(
        Effect.gen(function* () {
          const pi = yield* ScopedRef.get(piRef);
          if (pi !== undefined) yield* abortAll(pi);
          yield* closeSession;
        }),
      )
      .pipe(
        Effect.annotateLogs(attributes),
        Effect.withSpan("ChannelSession.abortAndDiscard", { attributes }),
      );

    const status = Effect.fn("ChannelSession.status", { attributes })(function* (
      channel: GuildTextBasedChannel,
    ) {
      const pi = yield* getOrOpenSession(channel);
      return yield* readSessionStatus({
        harness: pi.harness,
        conversation: pi.conversation,
        models: piContext.modelRuntime,
      }).pipe(mapToChannelSessionError);
    }, Effect.annotateLogs(attributes));

    const messageCounts = Effect.fn("ChannelSession.messageCounts", { attributes })(function* (
      channel: GuildTextBasedChannel,
    ) {
      const pi = yield* getOrOpenSession(channel);
      return yield* countMessages(pi.conversation).pipe(mapToChannelSessionError);
    }, Effect.annotateLogs(attributes));

    return {
      abort,
      abortAndDiscard,
      activate,
      resume,
      compact,
      discard,
      status,
      messageCounts,
    } satisfies ChannelSession;
  }).pipe(
    // Construction-scoped only; the returned operations carry their own attributes.
    Effect.annotateLogs({ channelId: input.channelId }),
    Effect.annotateSpans({ channelId: input.channelId }),
  );
