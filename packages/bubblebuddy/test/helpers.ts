import { Layer, Redacted } from "effect";
import { EnvConfig, type EnvConfigShape } from "../src/config/env.ts";

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
