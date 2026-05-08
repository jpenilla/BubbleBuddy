import { AuthStorage, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";

import { AppConfig } from "../config.ts";

export class PiContext extends Context.Service<
  PiContext,
  {
    readonly agentDir: string;
    readonly authStorage: AuthStorage;
    readonly model: Model<Api>;
    readonly modelRegistry: ModelRegistry;
  }
>()("bubblebuddy/pi/PiContext") {
  static readonly layer = Layer.effect(
    PiContext,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const model = modelRegistry.find(config.modelProvider, config.modelId);
      if (model === undefined) {
        const registryError = modelRegistry.getError();
        const suffix = registryError === undefined ? "" : ` Model registry error: ${registryError}`;
        throw new Error(
          `Unknown PI_MODEL "${config.modelId}" for provider "${config.modelProvider}".${suffix}`,
        );
      }

      yield* Effect.logInfo(`Using model: ${model.provider}/${model.id}`);

      return PiContext.of({
        agentDir: getAgentDir(),
        authStorage,
        model,
        modelRegistry,
      });
    }),
  );
}
