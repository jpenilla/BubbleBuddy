import { resolve } from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Redacted } from "effect";
import { Config, ConfigProvider, Data, Effect, Schema, FileSystem } from "effect";

// Matches @mariozechner/pi-agent-core's ThinkingLevel type.
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export type { ThinkingLevel };

const McpServerConfigEntrySchema = Schema.Union([
  Schema.Struct({
    url: Schema.NonEmptyString,
    bearerTokenEnv: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    command: Schema.NonEmptyString,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
]);

const McpServersConfigSchema = Schema.Record(Schema.String, McpServerConfigEntrySchema);

export type McpServerConfigEntry = Schema.Schema.Type<typeof McpServerConfigEntrySchema>;

const PositiveFiniteFromStringSchema = Schema.FiniteFromString.check(Schema.isGreaterThan(0));

export interface AppConfigShape {
  readonly discordToken: Redacted.Redacted<string>;
  readonly botProfile: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly storageDirectory: string;
  readonly enableAgenticWorkspace: boolean;
  readonly thinkingLevel: ThinkingLevel;
  readonly typingIndicatorIntervalMs: number;
  readonly channelIdleTimeoutMs: number;
  readonly mcpServers: Record<string, McpServerConfigEntry>;
  readonly discordContextTemplate: string;
}

class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const normalizeLineEndings = (value: string): string => value.replaceAll("\r\n", "\n");

const readTextFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path);
    return normalizeLineEndings(text);
  });

const CONFIG_FILE_NAME = "bubblebuddy.json";

export const loadAppConfig: Effect.Effect<AppConfigShape, ConfigError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const text = yield* readTextFile(CONFIG_FILE_NAME);
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) => new ConfigError({ message: `Invalid JSON in ${CONFIG_FILE_NAME}`, cause: e }),
    });
    const jsonProvider = ConfigProvider.fromUnknown(json);
    const envProvider = ConfigProvider.fromEnv().pipe(ConfigProvider.constantCase);

    const discordToken = yield* Config.schema(
      Schema.Redacted(Schema.NonEmptyString),
      "discordToken",
    ).parse(envProvider);

    // Required
    const jsonConfig = Config.all({
      botProfileFile: Config.nonEmptyString("botProfileFile"),
      modelProvider: Config.nonEmptyString("modelProvider"),
      modelId: Config.nonEmptyString("modelId"),
      storageDirectory: Config.nonEmptyString("storageDirectory"),
      enableAgenticWorkspace: Config.boolean("enableAgenticWorkspace"),

      // Optional with defaults
      thinkingLevel: Config.schema(Schema.Literals(THINKING_LEVELS), "thinkingLevel").pipe(
        Config.withDefault("minimal"),
      ),
      typingIndicatorIntervalMs: Config.schema(
        PositiveFiniteFromStringSchema,
        "typingIndicatorIntervalMs",
      ).pipe(Config.withDefault(8000)),
      channelIdleTimeoutMs: Config.schema(
        PositiveFiniteFromStringSchema,
        "channelIdleTimeoutMs",
      ).pipe(Config.withDefault(30 * 60 * 1000)),
      mcpServers: Config.schema(McpServersConfigSchema, "mcpServers").pipe(Config.withDefault({})),
    });

    const cfg = yield* jsonConfig.parse(jsonProvider);
    const botProfile = yield* readTextFile(cfg.botProfileFile);

    // Extras, i.e. from other files
    const discordContextTemplate = yield* readTextFile("discord-context.md");

    return {
      // Required
      discordToken,
      botProfile,
      modelProvider: cfg.modelProvider,
      modelId: cfg.modelId,
      storageDirectory: resolve(cfg.storageDirectory),
      enableAgenticWorkspace: cfg.enableAgenticWorkspace,

      // Optional with defaults
      thinkingLevel: cfg.thinkingLevel,
      typingIndicatorIntervalMs: cfg.typingIndicatorIntervalMs,
      channelIdleTimeoutMs: cfg.channelIdleTimeoutMs,
      mcpServers: cfg.mcpServers,

      // Extras, i.e. from other files
      discordContextTemplate,
    } satisfies AppConfigShape;
  }).pipe(
    Effect.mapError((error) => new ConfigError({ message: "Configuration error", cause: error })),
  );
