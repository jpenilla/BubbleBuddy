import { Client, Events, GatewayIntentBits } from "discord.js";
import { Cause, Context, Deferred, Effect, FiberSet, Layer, Redacted, Schema } from "effect";

export class LoginError extends Schema.TaggedError<LoginError>()("DiscordClient.LoginError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Service extends Context.Service<Service, Client<true>>()(
  "bubblebuddy/discord/DiscordClient",
) {}

const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
] as const;

export const layer = (discordToken: Redacted.Redacted<string>) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new Client({ intents: INTENTS })),
        (client) =>
          Effect.tryPromise(() => client.destroy()).pipe(
            Effect.ignore({ log: "Warn", message: "Discord client destruction failed" }),
          ),
      );
      yield* observeDiagnostics(client);
      return yield* login(client, discordToken);
    }),
  );

const observeDiagnostics = Effect.fnUntraced(function* (client: Client) {
  const fibers = yield* FiberSet.make<void, never>();
  const runFork = yield* FiberSet.runtime(fibers)();
  const onError = (error: Error): void => {
    runFork(Effect.logError("Discord client error", Cause.fail(error)));
  };
  const onWarning = (warning: string): void => {
    runFork(Effect.logWarning("Discord client warning").pipe(Effect.annotateLogs({ warning })));
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      client.on(Events.Error, onError);
      client.on(Events.Warn, onWarning);
    }),
    () =>
      Effect.gen(function* () {
        client.removeListener(Events.Error, onError);
        client.removeListener(Events.Warn, onWarning);
        yield* FiberSet.awaitEmpty(fibers).pipe(
          Effect.timeout("3 seconds"),
          Effect.catchTag("TimeoutError", (error) =>
            Effect.logWarning("Timed out waiting for Discord diagnostic handlers to exit", error),
          ),
        );
      }),
  );
});

const login = Effect.fn("DiscordClient.login")(
  function* (client: Client, token: Redacted.Redacted<string>) {
    yield* Effect.logInfo("Logging in to Discord");
    const readyClient = yield* Deferred.make<Client<true>, LoginError>();
    const onReady = (ready: Client<true>) => {
      Deferred.doneUnsafe(readyClient, Effect.succeed(ready));
    };
    const onError = (error: Error) => {
      Deferred.doneUnsafe(
        readyClient,
        Effect.fail(new LoginError({ message: "Error connecting to Discord", cause: error })),
      );
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        client.once(Events.ClientReady, onReady);
        client.once(Events.Error, onError);
      }),
      () =>
        Effect.sync(() => {
          client.removeListener(Events.ClientReady, onReady);
          client.removeListener(Events.Error, onError);
        }),
    );

    yield* Effect.tryPromise({
      try: () => client.login(Redacted.value(token)),
      catch: (error) => new LoginError({ message: "Failed to login to Discord", cause: error }),
    });

    return yield* Deferred.await(readyClient).pipe(
      Effect.tap((c) =>
        Effect.logInfo("Connected to Discord").pipe(
          Effect.annotateLogs({ botUserTag: c.user.tag }),
        ),
      ),
    );
  },
  Effect.scoped,
  Effect.timeout("30 seconds"),
  Effect.catchTag("TimeoutError", (timeout) =>
    Effect.fail(new LoginError({ message: "Timed out connecting to Discord", cause: timeout })),
  ),
);

export * as DiscordClient from "./discord-client.ts";
