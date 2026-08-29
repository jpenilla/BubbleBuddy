import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";

import { makeChannelSession } from "../src/channels/channel-session.ts";
import {
  ChannelSessions,
  type ChannelSessionLookupOptions,
} from "../src/channels/channel-sessions.ts";
import { ChannelStateRepository } from "../src/channels/state-repository.ts";
import { AppHome } from "../src/config/env.ts";
import { FileConfig, type FileConfigShape } from "../src/config/file.ts";
import { DatabaseLive } from "../src/database.ts";
import { makeTestEnvLayer, makeTestFileConfig } from "./helpers.ts";

const testLayer = (
  config: FileConfigShape,
  appHome: string,
  onLookup: (options: ChannelSessionLookupOptions) => Effect.Effect<void> = () => Effect.void,
) =>
  ChannelSessions.layerWith((options) =>
    onLookup(options).pipe(
      Effect.andThen(
        makeChannelSession({
          ...options,
          makeAgent: () => Effect.die("Agent session creation is not expected in these tests"),
        }),
      ),
    ),
  ).pipe(
    Layer.provide(ChannelStateRepository.layer),
    Layer.provide(DatabaseLive),
    Layer.provide(Layer.succeed(FileConfig, config)),
    Layer.provide(AppHome.layerNoDeps),
    Layer.provide(makeTestEnvLayer({ appHome })),
    Layer.provide(NodeServices.layer),
  );

it.layer(NodeServices.layer)("channel sessions", (it) => {
  it.effect("evicts and recreates idle channel entries after the idle timeout", () => {
    const config = makeTestFileConfig();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appHome = yield* fs.makeTempDirectoryScoped({ prefix: "bb-channel-sessions-" });

      yield* Effect.gen(function* () {
        const manager = yield* ChannelSessions;

        const session1 = yield* Effect.scoped(manager.get("ch-1"));
        yield* session1.toggleShowThinking;

        yield* TestClock.adjust(config.channelIdleTimeoutMs + 1);

        const session2 = yield* Effect.scoped(manager.get("ch-1"));
        expect(session2).not.toBe(session1);
      }).pipe(Effect.scoped, Effect.provide(testLayer(config, appHome)));
    });
  });

  it.effect("keeps channel entry when re-acquired within the idle timeout", () => {
    const config = makeTestFileConfig({ channelIdleTimeoutMs: 5000 });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appHome = yield* fs.makeTempDirectoryScoped({ prefix: "bb-channel-sessions-" });

      yield* Effect.gen(function* () {
        const manager = yield* ChannelSessions;

        const session1 = yield* Effect.scoped(manager.get("ch-2"));

        yield* TestClock.adjust(10);
        const session2 = yield* Effect.scoped(manager.get("ch-2"));
        expect(session2).toBe(session1);
      }).pipe(Effect.scoped, Effect.provide(testLayer(config, appHome)));
    });
  });

  it.effect("does not evict a channel while asynchronous work holds a lease", () => {
    const config = makeTestFileConfig({ channelIdleTimeoutMs: 5000 });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appHome = yield* fs.makeTempDirectoryScoped({ prefix: "bb-channel-sessions-" });
      const leaseReady = yield* Deferred.make<ChannelSessionLookupOptions["acquireLease"]>();

      yield* Effect.gen(function* () {
        const manager = yield* ChannelSessions;
        const session1 = yield* Effect.scoped(manager.get("ch-leased"));
        const acquireLease = yield* Deferred.await(leaseReady);
        const lease = yield* acquireLease;

        yield* TestClock.adjust(config.channelIdleTimeoutMs + 1);
        const session2 = yield* Effect.scoped(manager.get("ch-leased"));
        expect(session2).toBe(session1);

        yield* lease.release;
        yield* TestClock.adjust(config.channelIdleTimeoutMs + 1);
        const session3 = yield* Effect.scoped(manager.get("ch-leased"));
        expect(session3).not.toBe(session1);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          testLayer(config, appHome, (options) =>
            Deferred.succeed(leaseReady, options.acquireLease).pipe(Effect.asVoid),
          ),
        ),
      );
    });
  });

  it.effect("toggleShowThinking persists showThinking", () => {
    const config = makeTestFileConfig();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appHome = yield* fs.makeTempDirectoryScoped({ prefix: "bb-channel-sessions-" });

      yield* Effect.gen(function* () {
        const manager = yield* ChannelSessions;
        const session = yield* manager.get("ch-3");
        const newValue = yield* session.toggleShowThinking;

        expect(newValue).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(testLayer(config, appHome)));
    });
  });
});
