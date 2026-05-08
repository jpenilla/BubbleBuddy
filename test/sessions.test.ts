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
  test("evicts and recreates idle channel entries after the idle timeout", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bb-test-"));
    const config = makeConfig(tmpDir);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* ChannelSessions;

          // Acquire in a closed scope → refCount drops to 0 → idle timer starts.
          const runtime1 = yield* Effect.scoped(manager.get("ch-1"));
          yield* runtime1.toggleShowThinking();

          // Wait past the idle timeout so the entry is evicted.
          yield* Effect.sleep(config.channelIdleTimeoutMs + 50);

          // Should be a different runtime — the original was evicted and recreated.
          const runtime2 = yield* Effect.scoped(manager.get("ch-1"));
          expect(runtime2).not.toBe(runtime1);
        }).pipe(Effect.scoped, Effect.provide(testLayer(config))),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("keeps channel entry when re-acquired within the idle timeout", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bb-test-"));
    // Use a longer idle timeout so the re-acquire lands before eviction.
    const config = { ...makeConfig(tmpDir), channelIdleTimeoutMs: 5000 };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* ChannelSessions;

          const runtime1 = yield* Effect.scoped(manager.get("ch-2"));

          // Re-acquire well before the 5s idle timeout — should be the same runtime.
          yield* Effect.sleep(10);
          const runtime2 = yield* Effect.scoped(manager.get("ch-2"));
          expect(runtime2).toBe(runtime1);
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
          const runtime = yield* manager.get("ch-3");
          const newValue = yield* runtime.toggleShowThinking();

          expect(newValue).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(testLayer(config))),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
