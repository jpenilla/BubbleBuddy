import { Context, Effect, FileSystem, Layer } from "effect";
import { AppConfig } from "./config.ts";

const normalizeLineEndings = (value: string): string => value.replaceAll("\r\n", "\n");

export const readTextFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path);
    return normalizeLineEndings(text);
  });

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
      const botProfile = yield* readTextFile(config.botProfileFile);
      const discordContextTemplate = yield* readTextFile("discord-context.md");

      return LoadedResources.of({
        botProfile,
        discordContextTemplate,
      });
    }),
  );
}
