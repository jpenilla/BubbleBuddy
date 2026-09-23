import { type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

export type SessionEvent<Type extends AgentSessionEvent["type"]> = Extract<
  AgentSessionEvent,
  { type: Type }
>;

export const subscribe = (session: AgentSession, callback: (event: AgentSessionEvent) => void) =>
  Effect.acquireRelease(
    Effect.sync(() => session.subscribe(callback)),
    (unsubscribe) => Effect.sync(unsubscribe),
  ).pipe(Effect.asVoid);
