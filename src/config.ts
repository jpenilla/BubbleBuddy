import { resolve } from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Config, ConfigProvider, Context, Data, Effect, Schema, Layer } from "effect";
import { readTextFile } from "./resources.ts";

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
  readonly botProfileFile: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly storageDirectory: string;
  readonly enableAgenticWorkspace: boolean;
  readonly thinkingLevel: ThinkingLevel;
  readonly typingIndicatorIntervalMs: number;
  readonly channelIdleTimeoutMs: number;
  readonly mcpServers: Record<string, McpServerConfigEntry>;
}

class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const wrapConfigError = Effect.mapError((error) => {
  if (error instanceof ConfigError) return error;
  return new ConfigError({ message: "Configuration error", cause: error });
});

const CONFIG_FILE_NAME = "bubblebuddy.json";

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
  "bubblebuddy/AppConfig",
) {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const text = yield* readTextFile(CONFIG_FILE_NAME);
      const json = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (e) => new ConfigError({ message: `Invalid JSON in ${CONFIG_FILE_NAME}`, cause: e }),
      });
      const jsonProvider = ConfigProvider.fromUnknown(json);

      const jsonConfig = Config.all({
        // Required
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
        mcpServers: Config.schema(McpServersConfigSchema, "mcpServers").pipe(
          Config.withDefault({}),
        ),
      });

      const cfg = yield* jsonConfig.parse(jsonProvider);

      return AppConfig.of({
        // Required
        botProfileFile: cfg.botProfileFile,
        modelProvider: cfg.modelProvider,
        modelId: cfg.modelId,
        storageDirectory: resolve(cfg.storageDirectory),
        enableAgenticWorkspace: cfg.enableAgenticWorkspace,

        // Optional with defaults
        thinkingLevel: cfg.thinkingLevel,
        typingIndicatorIntervalMs: cfg.typingIndicatorIntervalMs,
        channelIdleTimeoutMs: cfg.channelIdleTimeoutMs,
        mcpServers: cfg.mcpServers,
      });
    }).pipe(wrapConfigError),
  );
}
