import { AuthStorage, getAgentDir, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { Effect } from "effect";

import { AppConfig } from "./config.ts";
import { LoadedResources } from "./resources.ts";
import { resolvePiModel } from "./pi/model.ts";
import { createChannelSessionManager } from "./sessions.ts";
import { registerActivationHandler } from "./discord/activation.ts";
import { registerSlashCommands } from "./discord/commands.ts";

export const program = Effect.gen(function* () {
  const config = yield* AppConfig;
  const resources = yield* LoadedResources;
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
    resources,
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
