import { basename } from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { Data, Effect, Option, Scope, Semaphore } from "effect";

import { SHOW_THINKING_DEFAULT, type ChannelRepositoryError } from "./channel-repository.ts";
import type { ChannelState } from "./channel-state.ts";
import { formatMessageForPrompt } from "./discord/message-formatting.ts";
import type { PromptTemplateContext } from "./domain/prompt.ts";
import type { ChannelSessionOperationError, ScopedPiChannelSession } from "./pi/channel-session.ts";
import type { SessionKeepAliveFactory } from "./sessions.ts";

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
  makeKeepAlive: SessionKeepAliveFactory,
) => Effect.Effect<
  { pi: ScopedPiChannelSession; sessionManager: SessionManager },
  ChannelRuntimeError
>;

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
  readonly createPiSession: CreatePiSession;
  readonly state: ChannelState;
  readonly makeKeepAlive: SessionKeepAliveFactory;
}

export const makeChannelRuntime = (
  options: ChannelRuntimeOptions,
): Effect.Effect<ChannelRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const state = options.state;
    let pi: ScopedPiChannelSession | undefined;

    const getOrCreatePi = (
      input: CreateSessionParams,
      mode: "create" | "resume",
    ): Effect.Effect<ScopedPiChannelSession, ChannelRuntimeError, Scope.Scope> =>
      Effect.gen(function* () {
        if (pi !== undefined) {
          return pi;
        }

        const created = yield* options.createPiSession(input, state, options.makeKeepAlive);
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

    const activate = (
      input: ActivationParams,
    ): Effect.Effect<void, ChannelRuntimeError, Scope.Scope> =>
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
    ): Effect.Effect<CompactResult, ChannelRuntimeError, Scope.Scope> => {
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
            yield* session.session
              .requestCompaction(input.customInstructions)
              .pipe(Effect.ignore({ log: "Warn", message: "Session compaction failed" }));
            yield* state.persistIfDirty();
            return "done";
          }),
        )
        .pipe(Effect.map(Option.getOrElse(() => "rejected-busy" as const)));
    };

    const discardPiSession = (): Effect.Effect<DiscardResult, ChannelRuntimeError> =>
      lock
        .withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            if (pi?.session.isStreaming || pi?.session.isCompacting || pi?.session.isRetrying) {
              return "rejected-busy" as const;
            }

            const session = pi;
            pi = undefined;
            if (session !== undefined) {
              yield* session.close;
            }

            state.clearActiveSession();
            yield* state.persistIfDirty();
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

    return yield* Effect.acquireRelease(
      Effect.succeed({
        activate,
        compact,
        discardPiSession,
        toggleShowThinking,
      }),
      () =>
        lock
          .withPermit(
            Effect.gen(function* () {
              const session = pi;
              pi = undefined;
              if (session !== undefined) {
                yield* session.close;
              }

              yield* state.persistIfDirty();
            }),
          )
          .pipe(Effect.ignore({ log: "Error", message: "Runtime cleanup failed" })),
    );
  });
