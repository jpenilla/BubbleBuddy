import { Context, Effect, FileSystem, Layer } from "effect";

import { AppConfig } from "./config.ts";
import { normalizeLineEndings } from "./shared/text.ts";

export interface LoadedResourcesShape {
  readonly botProfile: string;
  readonly discordContextTemplate: string;
}

export class LoadedResources extends Context.Service<LoadedResources, LoadedResourcesShape>()(
  "bubblebuddy/LoadedResources",
) {
  static readonly layer = Layer.effect(
    LoadedResources,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;
      const botProfile = normalizeLineEndings(yield* fs.readFileString(config.botProfileFile));
      const discordContextTemplate = normalizeLineEndings(
        yield* fs.readFileString("discord-context.md"),
      );

      return LoadedResources.of({
        botProfile,
        discordContextTemplate,
      });
    }),
  );
}
