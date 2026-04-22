import {
  getModels,
  getProviders,
  registerBuiltInApiProviders,
  type Api,
  type KnownProvider,
  type Model,
} from "@mariozechner/pi-ai";

let providersRegistered = false;

export const ensurePiProvidersRegistered = (): void => {
  if (!providersRegistered) {
    registerBuiltInApiProviders();
    providersRegistered = true;
  }
};

export const resolvePiModel = (providerId: string, modelId: string): Model<Api> => {
  ensurePiProvidersRegistered();

  if (!getProviders().includes(providerId as KnownProvider)) {
    throw new Error(`Unsupported PI_PROVIDER "${providerId}".`);
  }

  const model = getModels(providerId as KnownProvider).find(
    (candidate) => candidate.id === modelId,
  );

  if (model === undefined) {
    throw new Error(`Unknown PI_MODEL "${modelId}" for provider "${providerId}".`);
  }

  return model as Model<Api>;
};
