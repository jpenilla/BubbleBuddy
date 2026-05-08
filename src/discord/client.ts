import { Client, Events, GatewayIntentBits, type ClientEvents } from "discord.js";
import {
  Config,
  Context,
  Deferred,
  Effect,
  FiberSet,
  Layer,
  Redacted,
  Schema,
  Scope,
} from "effect";

export class DiscordLoginError extends Schema.TaggedErrorClass<DiscordLoginError>()(
  "DiscordLoginError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
] as const;

export interface DiscordEvents {
  /**
   * Register a plain event listener within the current scope.
   */
  on: <Event extends keyof ClientEvents>(
    event: Event,
    listener: (...args: ClientEvents[Event]) => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Register a plain single-shot event listener within the current scope.
   */
  once: <Event extends keyof ClientEvents>(
    event: Event,
    listener: (...args: ClientEvents[Event]) => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Register an Effectful event listener within the current scope, capturing registration context.
   */
  forkOn: <Event extends keyof ClientEvents, A, E, R>(
    event: Event,
    listener: (...args: ClientEvents[Event]) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<void, never, Scope.Scope | R>;
}

export class Discord extends Context.Service<
  Discord,
  {
    readonly client: Client<true>;
    readonly events: DiscordEvents;
  }
>()("bubblebuddy/discord/Discord") {
  static readonly layer = Layer.effect(
    Discord,
    Effect.gen(function* () {
      const token = yield* Config.redacted("DISCORD_TOKEN");
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new Client({ intents: INTENTS })),
        (client) =>
          Effect.tryPromise(() => client.destroy()).pipe(
            Effect.ignore({ log: "Warn", message: "Error destroying Discord client" }),
          ),
      );

      const events: DiscordEvents = {
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
        forkOn: (event, listener) =>
          registerForkedEvent(
            (wrapper) => client.on(event, wrapper),
            (wrapper) => client.removeListener(event, wrapper),
            listener,
          ),
      };

      yield* events.forkOn(Events.Error, (error) => Effect.logError(error));
      yield* events.forkOn(Events.Warn, (warn) => Effect.logWarning(warn));
      // yield* events.forkOn(Events.Debug, (debug) => Effect.logDebug(debug));

      const readyClient = yield* loginClient(client, events, token);

      return Discord.of({
        client: readyClient,
        events,
      });
    }),
  );
}

const loginClient = (
  client: Client,
  events: DiscordEvents,
  token: Redacted.Redacted<string>,
): Effect.Effect<Client<true>, DiscordLoginError> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.logInfo("Logging in to Discord.");
      const readyClient = yield* Deferred.make<Client<true>, DiscordLoginError>();
      yield* events.once(Events.ClientReady, (ready: Client<true>) => {
        Deferred.doneUnsafe(readyClient, Effect.succeed(ready));
      });
      yield* events.once(Events.Error, (error: Error) => {
        Deferred.doneUnsafe(
          readyClient,
          Effect.fail(
            new DiscordLoginError({ message: "Error connecting to Discord", cause: error }),
          ),
        );
      });

      yield* Effect.tryPromise({
        try: () => client.login(Redacted.value(token)),
        catch: (error) =>
          new DiscordLoginError({ message: "Failed to login to Discord", cause: error }),
      });

      return yield* Deferred.await(readyClient).pipe(
        Effect.tap((c) => Effect.logInfo(`Connected to Discord as ${c.user.tag}`)),
      );
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchTag("TimeoutError", (timeout) =>
        Effect.fail(
          new DiscordLoginError({ message: "Timed out connecting to Discord", cause: timeout }),
        ),
      ),
    ),
  );

const registerForkedEvent = <Event extends keyof ClientEvents, A, E, R>(
  register: (wrapper: (...args: ClientEvents[Event]) => void) => void,
  unregister: (wrapper: (...args: ClientEvents[Event]) => void) => void,
  listener: (...args: ClientEvents[Event]) => Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make<unknown, never>();
    const runFork = yield* FiberSet.runtime(fibers)<R>();

    const wrapper = (...args: ClientEvents[Event]): void => {
      runFork(
        Effect.suspend(() => listener(...args)).pipe(
          Effect.ignore({ log: "Warn", message: "Unhandled error in event handler" }),
        ),
      );
    };

    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        register(wrapper);
      }),
      () =>
        Effect.gen(function* () {
          unregister(wrapper);
          yield* FiberSet.awaitEmpty(fibers).pipe(
            Effect.timeout("3 seconds"),
            Effect.catchTag("TimeoutError", (error) =>
              Effect.logWarning("Timed out waiting for event listeners to exit", error),
            ),
          );
        }),
    );
  });
