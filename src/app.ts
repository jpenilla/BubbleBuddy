import { getAgentDir, AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { Effect, Redacted } from "effect";

import { loadAppConfig } from "./config.ts";
import { resolvePiModel } from "./pi/model.ts";
import { createChannelSessionManager } from "./sessions.ts";
import { registerHandlers } from "./discord/handlers.ts";
import { registerSlashCommands } from "./discord/commands.ts";

const waitForReady = async (client: Client): Promise<Client<true>> =>
  new Promise((resolve, reject) => {
    client.once(Events.ClientReady, (readyClient) => resolve(readyClient));
    client.once(Events.Error, reject);
  });

const makeDiscordClient = (): Client =>
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

export const program = Effect.gen(function* () {
  yield* Effect.logInfo("Starting BubbleBuddy.");
  const config = yield* loadAppConfig;
  yield* Effect.logInfo("Configuration loaded.");
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = resolvePiModel(modelRegistry, config.modelProvider, config.modelId);
  const sessions = createChannelSessionManager({
    agentDir,
    authStorage,
    config,
    model,
    modelRegistry,
  });

  yield* Effect.logInfo("Pi model initialized.");

  const client = yield* Effect.acquireRelease(Effect.sync(makeDiscordClient), (client) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("Shutdown requested. Stopping Discord intake.");
      client.removeAllListeners(Events.MessageCreate);
      client.removeAllListeners(Events.InteractionCreate);

      yield* Effect.logInfo("Shutting down channel sessions.");
      yield* Effect.tryPromise(() => sessions.shutdown()).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.logWarning("Timed out waiting for sessions to shut down."),
        }),
        Effect.catch((error: unknown) =>
          Effect.logWarning(`Session shutdown failed: ${String(error)}`),
        ),
      );

      yield* Effect.logInfo("Destroying Discord client.");
      client.destroy();
      yield* Effect.logInfo("Shutdown cleanup complete.");
    }),
  );

  yield* Effect.logInfo("Logging into Discord.");
  const readyClient = yield* Effect.tryPromise(async () => {
    const ready = waitForReady(client);
    await client.login(Redacted.value(config.discordToken));
    return await ready;
  });
  registerHandlers(readyClient, sessions);

  yield* Effect.logInfo("Registering Discord slash commands.");
  yield* Effect.tryPromise(() => registerSlashCommands(readyClient));
  yield* Effect.logInfo("Discord slash commands registered.");

  yield* Effect.logInfo(`Connected to Discord as ${readyClient.user.tag}`);
  return yield* Effect.never;
});
