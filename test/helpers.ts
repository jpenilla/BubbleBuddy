import { Layer, Redacted } from "effect";
import { EnvConfig, type EnvConfigShape } from "../src/config/env.ts";
import { type FileConfigShape } from "../src/config/file.ts";

const defaultFileConfig: FileConfigShape = {
  botProfileFile: "profiles/test.md",
  channelIdleTimeoutMs: 1,
  enableAgenticWorkspace: false,
  mcpServers: {},
  modelId: "test-model",
  modelProvider: "test",
  thinkingLevel: "medium",
};

export const makeTestFileConfig = (overrides: Partial<FileConfigShape> = {}): FileConfigShape => ({
  ...defaultFileConfig,
  ...overrides,
});

const defaultEnvConfig: EnvConfigShape = {
  appHome: "/tmp/bb-test",
  discordToken: Redacted.make("test-token"),
};

export const makeTestEnvConfig = (overrides: Partial<EnvConfigShape> = {}): EnvConfigShape => ({
  ...defaultEnvConfig,
  ...overrides,
});

export const makeTestEnvLayer = (overrides: Partial<EnvConfigShape> = {}) =>
  Layer.succeed(EnvConfig, makeTestEnvConfig(overrides));
