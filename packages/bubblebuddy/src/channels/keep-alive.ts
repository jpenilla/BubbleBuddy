import type { Effect, Scope } from "effect";

export type SessionKeepAlive = {
  release: Effect.Effect<void, never, never>;
};

export type SessionKeepAliveFactory = () => Effect.Effect<SessionKeepAlive, never, Scope.Scope>;
