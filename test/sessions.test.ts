import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import type { Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

import { ChannelRepository } from "../src/channel-repository.ts";
import { PiContext } from "../src/pi/context.ts";
import { ChannelSessions } from "../src/sessions.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { LoadedResources, type LoadedResourcesShape } from "../src/resources.ts";

const makeConfig = (storageDir: string): AppConfigShape => ({
  botProfileFile: "profiles/test.md",
  channelIdleTimeoutMs: 1,
  enableAgenticWorkspace: false,
  mcpServers: {},
  modelId: "test-model",
  modelProvider: "test",
  storageDirectory: storageDir,
  thinkingLevel: "medium",
  typingIndicatorIntervalMs: 1000,
});

const resources: LoadedResourcesShape = {
  botProfile: "test",
  discordContextTemplate: "",
};

const testLayer = (config: AppConfigShape) =>
  ChannelSessions.layer.pipe(
    Layer.provideMerge(ChannelRepository.layer),
    Layer.provideMerge(Layer.succeed(AppConfig, config)),
    Layer.provideMerge(Layer.succeed(LoadedResources, resources)),
    Layer.provideMerge(
      Layer.succeed(PiContext, {
        agentDir: "",
        authStorage: AuthStorage.create(),
        model: {} as unknown as Model<never>,
        modelRegistry: {} as unknown as ModelRegistry,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("channel session manager", () => {
  test("keeps idle channel entries after the idle timeout", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bb-test-"));
    const config = makeConfig(tmpDir);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* ChannelSessions;
          const runtime = yield* manager.get("ch-1");
          yield* runtime.toggleShowThinking();

          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
          expect(yield* manager.get("ch-1")).toBe(runtime);
        }).pipe(Effect.scoped, Effect.provide(testLayer(config))),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("toggleShowThinking persists dirty state", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bb-test-"));
    const config = makeConfig(tmpDir);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* ChannelSessions;
          const runtime = yield* manager.get("ch-2");
          const newValue = yield* runtime.toggleShowThinking();

          expect(newValue).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(testLayer(config))),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
