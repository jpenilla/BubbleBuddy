import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { AppHome } from "./config/env.ts";
import { FileConfig } from "./config/file.ts";
import { normalizeLineEndings } from "./shared/text.ts";

const makeLoadedResources = Effect.gen(function* () {
  const config = yield* FileConfig;
  const appHome = yield* AppHome;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const packageRoot = path.join(
    path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
    "..",
  );
  const botProfilePath =
    config.botProfileFile === "default"
      ? path.join(packageRoot, "profiles", "friendly.md")
      : path.isAbsolute(config.botProfileFile)
        ? config.botProfileFile
        : path.join(appHome, config.botProfileFile);

  const botProfile = normalizeLineEndings(yield* fs.readFileString(botProfilePath));
  const discordContextTemplate = normalizeLineEndings(
    yield* fs.readFileString(path.join(packageRoot, "discord-context.md")),
  );

  return LoadedResources.of({
    botProfile,
    discordContextTemplate,
  });
});

export class LoadedResources extends Context.Service<
  LoadedResources,
  {
    readonly botProfile: string;
    readonly discordContextTemplate: string;
  }
>()("bubblebuddy/LoadedResources") {
  static readonly layerNoDeps = Layer.effect(LoadedResources, makeLoadedResources);
  static readonly layer = LoadedResources.layerNoDeps.pipe(
    Layer.provide(FileConfig.layer),
    Layer.provide(AppHome.layer),
  );
}
