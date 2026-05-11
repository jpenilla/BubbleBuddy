import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";

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

it.layer(NodeServices.layer)("channel runtimes", (it) => {
  it.effect("evicts and recreates idle channel entries after the idle timeout", () => {
    const config = makeTestFileConfig();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appHome = yield* fs.makeTempDirectoryScoped({ prefix: "bb-channel-runtimes-" });

      yield* Effect.gen(function* () {
        const manager = yield* ChannelRuntimes;

        const runtime1 = yield* Effect.scoped(manager.get("ch-1"));
        yield* runtime1.toggleShowThinking();

        yield* TestClock.adjust(config.channelIdleTimeoutMs + 1);

        const runtime2 = yield* Effect.scoped(manager.get("ch-1"));
        expect(runtime2).not.toBe(runtime1);
      }).pipe(Effect.scoped, Effect.provide(testLayer(config, appHome)));
    });
  });

  it.effect("keeps channel entry when re-acquired within the idle timeout", () => {
    const config = makeTestFileConfig({ channelIdleTimeoutMs: 5000 });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appHome = yield* fs.makeTempDirectoryScoped({ prefix: "bb-channel-runtimes-" });

      yield* Effect.gen(function* () {
        const manager = yield* ChannelRuntimes;

        const runtime1 = yield* Effect.scoped(manager.get("ch-2"));

        yield* TestClock.adjust(10);
        const runtime2 = yield* Effect.scoped(manager.get("ch-2"));
        expect(runtime2).toBe(runtime1);
      }).pipe(Effect.scoped, Effect.provide(testLayer(config, appHome)));
    });
  });

  it.effect("toggleShowThinking persists showThinking", () => {
    const config = makeTestFileConfig();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appHome = yield* fs.makeTempDirectoryScoped({ prefix: "bb-channel-runtimes-" });

      yield* Effect.gen(function* () {
        const manager = yield* ChannelRuntimes;
        const runtime = yield* manager.get("ch-3");
        const newValue = yield* runtime.toggleShowThinking();

        expect(newValue).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(testLayer(config, appHome)));
    });
  });
});
