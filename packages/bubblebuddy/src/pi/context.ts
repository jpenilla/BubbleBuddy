import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Path } from "effect";

import { FileConfig } from "../config/file.ts";

const createPiContext = Effect.gen(function* () {
  const config = yield* FileConfig;
  const path = yield* Path.Path;
  const agentDir = getAgentDir();
  const modelRuntime = yield* Effect.tryPromise(() =>
    ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    }),
  ).pipe(Effect.orDie);
  const model = modelRuntime.getModel(config.modelProvider, config.modelId);
  if (model === undefined) {
    const runtimeError = modelRuntime.getError();
    const suffix = runtimeError === undefined ? "" : ` Model runtime error: ${runtimeError}`;
    throw new Error(
      `Unknown PI_MODEL "${config.modelId}" for provider "${config.modelProvider}".${suffix}`,
    );
  }

  yield* Effect.logInfo(`Using model: ${model.provider}/${model.id}`);

  return PiContext.of({
    agentDir,
    model,
    modelRuntime,
  });
});

export class PiContext extends Context.Service<
  PiContext,
  {
    readonly agentDir: string;
    readonly model: Model<Api>;
    readonly modelRuntime: ModelRuntime;
  }
>()("bubblebuddy/pi/PiContext") {
  static readonly layerNoDeps = Layer.effect(PiContext, createPiContext);
  static readonly layer = PiContext.layerNoDeps.pipe(Layer.provide(FileConfig.layer));
}
