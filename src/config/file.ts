import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect";
import { AppHome } from "./env.ts";
import { ConfigError } from "./error.ts";
import { normalizeLineEndings } from "../shared/text.ts";

export type { ThinkingLevel };

const CONFIG_FILE_NAME = "bubblebuddy.json";

// Matches @earendil-works/pi-agent-core's ThinkingLevel type.
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

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

export type McpServerConfigEntry = Schema.Schema.Type<typeof McpServerConfigEntrySchema>;

const McpServersConfigSchema = Schema.Record(Schema.String, McpServerConfigEntrySchema);
const PositiveFiniteNumberSchema = Schema.Finite.check(Schema.isGreaterThan(0));
const ThinkingLevelSchema = Schema.Literals(THINKING_LEVELS);

export const ConfigFileSchema = Schema.Struct({
  botProfileFile: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("default")),
  ),
  modelProvider: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("YOUR_PROVIDER")),
  ),
  modelId: Schema.NonEmptyString.pipe(Schema.withDecodingDefaultKey(Effect.succeed("YOUR_MODEL"))),
  enableAgenticWorkspace: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  thinkingLevel: ThinkingLevelSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed("minimal"))),
  channelIdleTimeoutMs: PositiveFiniteNumberSchema.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(30 * 60 * 1000)),
  ),
  mcpServers: McpServersConfigSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});

export type FileConfigShape = typeof ConfigFileSchema.Type;

const defaultConfigFile = {
  botProfileFile: "default",
  modelProvider: "YOUR_PROVIDER",
  modelId: "YOUR_MODEL",
  enableAgenticWorkspace: true,
  thinkingLevel: "minimal",
  channelIdleTimeoutMs: 30 * 60 * 1000,
  mcpServers: {},
} satisfies FileConfigShape;

const fromPrettyJsonString = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(
    Schema.decodeTo(
      schema,
      new SchemaTransformation.Transformation(
        SchemaGetter.parseJson({}),
        SchemaGetter.stringifyJson({ space: 2 }),
      ),
    ),
  );

const ConfigFileJsonSchema = fromPrettyJsonString(ConfigFileSchema);
const decodeConfigFileJson = Schema.decodeUnknownEffect(ConfigFileJsonSchema);
const encodeConfigFileJson = Schema.encodeEffect(ConfigFileJsonSchema);

const ensureDirectory = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(path, { recursive: true })
      .pipe(
        Effect.mapError((cause) => new ConfigError({ message: `Failed to create ${path}`, cause })),
      );
  });

const writeDefaultConfigFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* encodeConfigFileJson(defaultConfigFile);

    yield* fs
      .writeFileString(path, `${text}\n`)
      .pipe(
        Effect.mapError((cause) => new ConfigError({ message: `Failed to create ${path}`, cause })),
      );
    yield* Effect.logInfo(`Created ${path} with default values.`);
  });

const readConfigFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(
      Effect.map(normalizeLineEndings),
      Effect.mapError((cause) => new ConfigError({ message: `Failed to read ${path}`, cause })),
    );

    return yield* decodeConfigFileJson(text).pipe(
      Effect.mapError((cause) => new ConfigError({ message: `Invalid ${path}`, cause })),
    );
  });

const readOrGenerateConfigFile = (appHome: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configPath = path.join(appHome, CONFIG_FILE_NAME);

    yield* ensureDirectory(appHome);

    const exists = yield* fs
      .exists(configPath)
      .pipe(
        Effect.mapError(
          (cause) => new ConfigError({ message: `Failed to check ${configPath}`, cause }),
        ),
      );

    if (!exists) {
      yield* writeDefaultConfigFile(configPath);
    }

    return yield* readConfigFile(configPath);
  });

const validateConfigFile = (file: FileConfigShape) =>
  Effect.gen(function* () {
    if (file.modelProvider === "YOUR_PROVIDER" || file.modelId === "YOUR_MODEL") {
      return yield* new ConfigError({
        message: `Edit ${CONFIG_FILE_NAME}: set modelProvider and modelId to your Pi provider and model.`,
      });
    }
  });

const loadFileConfig = Effect.gen(function* () {
  const appHome = yield* AppHome;
  const file = yield* readOrGenerateConfigFile(appHome);
  yield* validateConfigFile(file);
  return file;
});

export class FileConfig extends Context.Service<FileConfig, FileConfigShape>()(
  "bubblebuddy/FileConfig",
) {
  static readonly layer = Layer.effect(FileConfig, loadFileConfig);
}

export const FileConfigLive = FileConfig.layer;
