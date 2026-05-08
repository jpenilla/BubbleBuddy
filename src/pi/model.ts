import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export const resolvePiModel = (
  modelRegistry: ModelRegistry,
  providerId: string,
  modelId: string,
): Model<Api> => {
  const model = modelRegistry.find(providerId, modelId);

  if (model === undefined) {
    const registryError = modelRegistry.getError();
    const suffix = registryError === undefined ? "" : ` Model registry error: ${registryError}`;
    throw new Error(`Unknown PI_MODEL "${modelId}" for provider "${providerId}".${suffix}`);
  }

  return model;
};
