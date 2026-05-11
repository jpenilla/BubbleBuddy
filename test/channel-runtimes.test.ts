import { describe, expect, it } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { ChannelStateRepository } from "../src/channels/state-repository.ts";
import { PiChannelSessionFactory } from "../src/pi-session/session-factory.ts";
import { ChannelRuntimes } from "../src/channels/channel-runtimes.ts";
import { AppHome } from "../src/config/env.ts";
import { FileConfig, type FileConfigShape } from "../src/config/file.ts";
import { DatabaseLive } from "../src/database.ts";
import { LoadedResources, type LoadedResourcesShape } from "../src/resources.ts";
import { makeTestEnvLayer, makeTestFileConfig } from "./helpers.ts";

const resources: LoadedResourcesShape = {
  botProfile: "test",
  discordContextTemplate: "",
};

const testLayer = (config: FileConfigShape, appHome: string) =>
  ChannelRuntimes.layer.pipe(
    Layer.provideMerge(ChannelStateRepository.layer),
    Layer.provideMerge(DatabaseLive),
    Layer.provideMerge(Layer.succeed(FileConfig, config)),
    Layer.provideMerge(Layer.succeed(LoadedResources, resources)),
    Layer.provideMerge(
      Layer.succeed(PiChannelSessionFactory, {
        create: () => Effect.die("Pi session creation is not expected in these tests"),
      }),
    ),
    Layer.provideMerge(AppHome.layer),
    Layer.provideMerge(makeTestEnvLayer({ appHome })),
    Layer.provideMerge(NodeServices.layer),
  );

describe("channel runtimes", () => {
  it("evicts and recreates idle channel entries after the idle timeout", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bb-test-"));
    const config = makeTestFileConfig();

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* ChannelRuntimes;

          // Acquire in a closed scope → refCount drops to 0 → idle timer starts.
          const runtime1 = yield* Effect.scoped(manager.get("ch-1"));
          yield* runtime1.toggleShowThinking();

          // Wait past the idle timeout so the entry is evicted.
          yield* Effect.sleep(config.channelIdleTimeoutMs + 50);

          // Should be a different runtime — the original was evicted and recreated.
          const runtime2 = yield* Effect.scoped(manager.get("ch-1"));
          expect(runtime2).not.toBe(runtime1);
        }).pipe(Effect.scoped, Effect.provide(testLayer(config, tmpDir))),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps channel entry when re-acquired within the idle timeout", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bb-test-"));
    // Use a longer idle timeout so the re-acquire lands before eviction.
    const config = makeTestFileConfig({ channelIdleTimeoutMs: 5000 });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* ChannelRuntimes;

          const runtime1 = yield* Effect.scoped(manager.get("ch-2"));

          // Re-acquire well before the 5s idle timeout — should be the same runtime.
          yield* Effect.sleep(10);
          const runtime2 = yield* Effect.scoped(manager.get("ch-2"));
          expect(runtime2).toBe(runtime1);
        }).pipe(Effect.scoped, Effect.provide(testLayer(config, tmpDir))),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("toggleShowThinking persists showThinking", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bb-test-"));
    const config = makeTestFileConfig();

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* ChannelRuntimes;
          const runtime = yield* manager.get("ch-3");
          const newValue = yield* runtime.toggleShowThinking();

          expect(newValue).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(testLayer(config, tmpDir))),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
