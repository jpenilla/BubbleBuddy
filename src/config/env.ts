import { homedir } from "node:os";

import { Config, Context, Effect, Layer, Option, Path, Redacted } from "effect";

export type EnvConfigShape = {
  readonly appHome?: string;
  readonly discordToken: Redacted.Redacted<string>;
};

export const EnvConfigSchema = Config.all({
  appHome: Config.string("BUBBLEBUDDY_HOME").pipe(Config.option),
  discordToken: Config.redacted("DISCORD_TOKEN"),
});

export class EnvConfig extends Context.Service<EnvConfig, EnvConfigShape>()(
  "bubblebuddy/config/EnvConfig",
) {
  static readonly layer = Layer.effect(
    EnvConfig,
    Effect.gen(function* () {
      const config = yield* EnvConfigSchema;
      return EnvConfig.of({
        appHome: Option.getOrUndefined(config.appHome),
        discordToken: config.discordToken,
      });
    }),
  );
}

const defaultAppHome = Effect.gen(function* () {
  const path = yield* Path.Path;
  switch (process.platform) {
    case "darwin":
      return path.join(homedir(), "Library", "Application Support", "BubbleBuddy");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
        "BubbleBuddy",
      );
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
        "bubblebuddy",
      );
  }
});

export const resolveAppHome = Effect.gen(function* () {
  const env = yield* EnvConfig;
  const fromEnv = env.appHome;
  if (fromEnv) {
    return fromEnv;
  }
  return yield* defaultAppHome;
});

export class AppHome extends Context.Service<AppHome, string>()("bubblebuddy/AppHome") {
  static readonly layer = Layer.effect(AppHome, resolveAppHome);
}
