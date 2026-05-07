import { basename } from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { Data, Effect, Fiber, Option, Semaphore } from "effect";

import { SHOW_THINKING_DEFAULT, type ChannelRepositoryError } from "./channel-repository.ts";
import type { ChannelState } from "./channel-state.ts";
import { formatMessageForPrompt } from "./discord/message-formatting.ts";
import type { PromptTemplateContext } from "./domain/prompt.ts";
import type { ChannelSessionOperationError, ScopedPiChannelSession } from "./pi/channel-session.ts";

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
  readonly operation: "session" | "storage";
  readonly cause: unknown;
}> {}

export type ChannelRuntimeError =
  | ChannelRepositoryError
  | ChannelRuntimeOperationError
  | ChannelSessionOperationError;

export type CreatePiSession = (
  input: CreateSessionParams,
  channel: ChannelState,
) => Effect.Effect<
  { pi: ScopedPiChannelSession; sessionManager: SessionManager },
  ChannelRuntimeError
>;

export interface ChannelRuntimeOptions {
  readonly channelId: string;
  readonly createPiSession: CreatePiSession;
  readonly idleTimeoutMs: number;
  readonly state: ChannelState;
}

export interface ChannelRuntime {
  readonly activate: (input: ActivationParams) => Effect.Effect<void, ChannelRuntimeError>;
  readonly compact: (input: CompactionParams) => Effect.Effect<CompactResult, ChannelRuntimeError>;
  readonly discard: () => Effect.Effect<DiscardResult, ChannelRuntimeError>;
  readonly toggleShowThinking: () => Effect.Effect<boolean, ChannelRuntimeError>;
}

export type ChannelRuntimeEntry = ChannelRuntime & {
  readonly touch: () => Effect.Effect<void>;
  readonly shutdown: () => Effect.Effect<void, ChannelRuntimeError>;
};

export const makeChannelRuntime = (
  options: ChannelRuntimeOptions,
): Effect.Effect<ChannelRuntimeEntry> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const state = options.state;
    let pi: ScopedPiChannelSession | undefined;
    let idleFiber: Fiber.Fiber<void> | undefined;

    const isBusy = () =>
      pi?.session.isStreaming || pi?.session.isCompacting || pi?.session.isRetrying || false;

    const getOrCreatePi = (
      input: CreateSessionParams,
      mode: "create" | "resume",
    ): Effect.Effect<ScopedPiChannelSession, ChannelRuntimeError> =>
      Effect.gen(function* () {
        if (pi !== undefined) {
          return pi;
        }

        const created = yield* options.createPiSession(input, state);
        pi = created.pi;

        if (mode === "create") {
          const sessionFile = created.sessionManager.getSessionFile();
          if (sessionFile !== undefined) {
            const newActiveSession = basename(sessionFile);
            if (state.activeSession !== newActiveSession) {
              state.setActiveSession(newActiveSession);
            }
          }
          yield* state.persistIfDirty();
        }

        return pi;
      });

    const activate = (input: ActivationParams): Effect.Effect<void, ChannelRuntimeError> =>
      lock.withPermit(
        Effect.gen(function* () {
          const session = yield* getOrCreatePi(input, "create");
          yield* session.session.activate(
            formatMessageForPrompt(input.originMessage),
            input.originMessage.id,
          );
        }),
      );

    const compact = (
      input: CompactionParams,
    ): Effect.Effect<CompactResult, ChannelRuntimeError> => {
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
            if (pi?.session.isCompacting) {
              return "rejected-compacting";
            }
            if (pi?.session.isStreaming || pi?.session.isRetrying) {
              return "rejected-busy";
            }
            if (pi === undefined && state.activeSession === undefined) {
              return "no-session";
            }

            const session = yield* getOrCreatePi(input, "resume");
            state.touchActivity();
            yield* session.session
              .requestCompaction(input.customInstructions)
              .pipe(Effect.ignore({ log: "Warn", message: "Session compaction failed" }));
            state.touchActivity();
            yield* state.persistIfDirty();
            return "done";
          }),
        )
        .pipe(Effect.map(Option.getOrElse(() => "rejected-busy" as const)));
    };

    const discard = (): Effect.Effect<DiscardResult, ChannelRuntimeError> =>
      lock
        .withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            if (isBusy()) {
              yield* Effect.logInfo(
                `Session discard rejected for channel ${options.channelId}: session is busy.`,
              );
              return "rejected-busy" as const;
            }

            yield* close("dispose");
            return "discarded" as const;
          }),
        )
        .pipe(Effect.map(Option.getOrElse(() => "rejected-busy" as const)));

    const toggleShowThinking = (): Effect.Effect<boolean, ChannelRuntimeError> =>
      Effect.gen(function* () {
        const value = !(state.settings.showThinking ?? SHOW_THINKING_DEFAULT);
        state.modifySettings((settings) => {
          settings.showThinking = value === SHOW_THINKING_DEFAULT ? undefined : value;
        });
        yield* state.persistIfDirty();
        return value;
      });

    const idleCheck = (): Effect.Effect<void, ChannelRuntimeError> =>
      Effect.gen(function* () {
        if (Date.now() - state.lastActivity >= options.idleTimeoutMs && !isBusy()) {
          idleFiber = undefined;
          yield* close("shutdown");
        } else {
          yield* scheduleIdleClose();
        }
      });

    const scheduleIdleClose = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        idleFiber?.interruptUnsafe();
        idleFiber = yield* Effect.forkDetach(
          Effect.sleep(options.idleTimeoutMs).pipe(
            Effect.flatMap(() => lock.withPermit(idleCheck())),
            Effect.ignore({ log: "Warn", message: "Channel idle eviction failed" }),
          ),
        );
      });

    const touchUnsafe = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        state.touchActivity();
        yield* scheduleIdleClose();
      });

    const touch = (): Effect.Effect<void> => lock.withPermit(touchUnsafe());

    const close = (mode: "dispose" | "shutdown"): Effect.Effect<void, ChannelRuntimeError> =>
      Effect.gen(function* () {
        idleFiber?.interruptUnsafe();
        idleFiber = undefined;
        const session = pi;
        pi = undefined;
        yield* session?.close ?? Effect.void;
        if (mode === "dispose") {
          state.clearActiveSession();
        }
        yield* state.persistIfDirty();
      });

    yield* touchUnsafe();
    return {
      activate,
      compact,
      discard,
      toggleShowThinking,
      touch,
      shutdown: () => lock.withPermit(close("shutdown")),
    };
  });
