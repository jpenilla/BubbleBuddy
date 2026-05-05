import { getAgentDir, AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { Effect } from "effect";

import { type AppConfigShape, loadAppConfig } from "./config.ts";
import { resolvePiModel } from "./pi/model.ts";
import { createChannelSessionManager } from "./sessions.ts";
import { Discord } from "./discord/client.ts";
import { registerActivationHandler } from "./discord/activation.ts";
import { registerSlashCommands } from "./discord/commands.ts";

export const program = Effect.gen(function* () {
  yield* Effect.logInfo("Starting BubbleBuddy.");
  const config = yield* loadAppConfig;
  yield* Effect.logInfo("Configuration loaded.");
  return yield* main(config).pipe(Effect.provide(Discord.layer({ token: config.discordToken })));
});

const main = (config: AppConfigShape) =>
  Effect.gen(function* () {
    const agentDir = getAgentDir();
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = resolvePiModel(modelRegistry, config.modelProvider, config.modelId);
    yield* Effect.logInfo(`Using model: ${model.provider}/${model.id}`);
    const sessions = createChannelSessionManager({
      agentDir,
      authStorage,
      config,
      model,
      modelRegistry,
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Shutdown requested. Shutting down channel sessions.");
        yield* Effect.tryPromise(() => sessions.shutdown()).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.logWarning("Timed out waiting for sessions to shut down."),
          }),
          Effect.catch((error: unknown) =>
            Effect.logWarning(`Session shutdown failed: ${String(error)}`),
          ),
        );
        yield* Effect.logInfo("Shutdown cleanup complete.");
      }),
    );

    yield* registerActivationHandler(sessions);
    yield* registerSlashCommands(sessions);

    return yield* Effect.never;
  });
