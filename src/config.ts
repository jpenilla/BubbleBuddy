import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Config, ConfigProvider, Effect } from "effect";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AppConfigShape {
  readonly botProfile: string;
  readonly discordContextTemplate: string;
  readonly discordToken: string;
  readonly enableAgenticWorkspace: boolean;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly storageDirectory: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly typingIndicatorIntervalMs: number;
}

const normalizeLineEndings = (value: string): string => value.replaceAll("\r\n", "\n");

const parseThinkingLevel = (value: string): ThinkingLevel => {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      throw new Error(
        `Unsupported PI_THINKING_LEVEL "${value}". Expected one of off, minimal, low, medium, high, xhigh.`,
      );
  }
};

const parseBooleanFlag = (name: string, value: string): boolean => {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
      return true;
    case "0":
    case "false":
    case "no":
      return false;
    default:
      throw new Error(`Unsupported ${name} "${value}". Expected true/false.`);
  }
};

const readTextFile = (path: string, missingFileHint: string): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => normalizeLineEndings(await readFile(resolve(path), "utf8")),
    catch: (error) => {
      const reason = error instanceof Error && error.message.length > 0 ? `: ${error.message}` : "";
      return new Error(`Failed to read "${path}". ${missingFileHint}${reason}`);
    },
  });

const AppConfigSpec = Config.all({
  botProfileFile: Config.string("BOT_PROFILE_FILE").pipe(
    Config.withDefault("profiles/friendly.md"),
  ),
  discordContextTemplateFile: Config.string("DISCORD_CONTEXT_TEMPLATE_FILE").pipe(
    Config.withDefault("discord-context.md"),
  ),
  discordToken: Config.string("DISCORD_TOKEN"),
  enableAgenticWorkspace: Config.string("ENABLE_AGENTIC_WORKSPACE").pipe(
    Config.withDefault("false"),
  ),
  modelProvider: Config.string("PI_PROVIDER"),
  modelId: Config.string("PI_MODEL"),
  storageDirectory: Config.string("STORAGE_DIRECTORY"),
  thinkingLevel: Config.string("PI_THINKING_LEVEL").pipe(Config.withDefault("minimal")),
  typingIndicatorIntervalMs: Config.number("DISCORD_TYPING_INTERVAL_MS").pipe(
    Config.withDefault(8_000),
  ),
});

export const loadAppConfig = Effect.gen(function* () {
  const values = yield* AppConfigSpec.parse(ConfigProvider.fromEnv());
  const enableAgenticWorkspace = parseBooleanFlag(
    "ENABLE_AGENTIC_WORKSPACE",
    values.enableAgenticWorkspace,
  );

  if (enableAgenticWorkspace) {
    throw new Error("ENABLE_AGENTIC_WORKSPACE=true is not implemented yet.");
  }

  const botProfile = yield* readTextFile(
    values.botProfileFile.trim() || "profiles/friendly.md",
    "Use BOT_PROFILE_FILE to point at a committed profile such as profiles/friendly.md.",
  );
  const discordContextTemplate = yield* readTextFile(
    values.discordContextTemplateFile.trim() || "discord-context.md",
    "Copy discord-context.md.example to discord-context.md or set DISCORD_CONTEXT_TEMPLATE_FILE.",
  );
  const storageDirectory = values.storageDirectory.trim();

  if (storageDirectory.length === 0) {
    throw new Error("STORAGE_DIRECTORY must not be empty.");
  }

  return {
    botProfile,
    discordContextTemplate,
    discordToken: values.discordToken,
    enableAgenticWorkspace,
    modelId: values.modelId,
    modelProvider: values.modelProvider,
    storageDirectory: resolve(storageDirectory),
    thinkingLevel: parseThinkingLevel(values.thinkingLevel),
    typingIndicatorIntervalMs: values.typingIndicatorIntervalMs,
  } satisfies AppConfigShape;
});
