import type { Client, ClientEvents } from "discord.js";
import { Cause, Context, Effect, FiberSet, Layer, Scope } from "effect";
import { DiscordClient } from "./discord-client.ts";

export interface Listener<Event extends keyof ClientEvents, Return = void> {
  (...args: ClientEvents[Event]): Return;
}

export interface Interface {
  /** Register a plain event listener within the current scope. */
  readonly on: <Event extends keyof ClientEvents>(
    event: Event,
    listener: Listener<Event>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Register a plain single-shot event listener within the current scope. */
  readonly once: <Event extends keyof ClientEvents>(
    event: Event,
    listener: Listener<Event>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Register an Effectful listener. Each event runs the listener in a new fiber,
   * using the services available at registration. Invocations may overlap.
   * When the registration scope closes, remove the listener and interrupt its fibers.
   */
  readonly forkOn: <Event extends keyof ClientEvents, A, E, R>(
    event: Event,
    listener: Listener<Event, Effect.Effect<A, E, R>>,
  ) => Effect.Effect<void, never, Scope.Scope | R>;
}

export class Service extends Context.Service<Service, Interface>()(
  "bubblebuddy/discord/DiscordEvents",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* DiscordClient.Service;
    return Service.of({
      on: (event, listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            client.on(event, listener);
          }),
          () =>
            Effect.sync(() => {
              client.removeListener(event, listener);
            }),
        ),
      once: (event, listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            client.once(event, listener);
          }),
          () =>
            Effect.sync(() => {
              client.removeListener(event, listener);
            }),
        ),
      forkOn: (event, listener) => forkOn(client, event, listener),
    });
  }),
);

const forkOn = Effect.fnUntraced(function* <Event extends keyof ClientEvents, A, E, R>(
  client: Client<true>,
  event: Event,
  listener: Listener<Event, Effect.Effect<A, E, R>>,
) {
  const fibers = yield* FiberSet.make<unknown, never>();
  const runFork = yield* FiberSet.runtime(fibers)<R>();

  const wrapper = (...args: ClientEvents[Event]): void => {
    runFork(
      Effect.suspend(() => listener(...args)).pipe(
        Effect.onError((cause) =>
          (Cause.hasInterruptsOnly(cause)
            ? Effect.logDebug("Discord event handler interrupted", cause)
            : Effect.logError("Discord event handler failed", cause)
          ).pipe(Effect.annotateLogs({ eventName: event })),
        ),
        Effect.ignoreCause(),
      ),
    );
  };

  return yield* Effect.acquireRelease(
    Effect.sync(() => {
      client.on(event, wrapper);
    }),
    () =>
      Effect.sync(() => {
        client.removeListener(event, wrapper);
      }),
  );
});

export * as DiscordEvents from "./discord-events.ts";
