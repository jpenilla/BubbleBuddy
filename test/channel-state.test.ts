import { describe, expect, it } from "@effect/vitest";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { ChannelStateRepository } from "../src/channels/state-repository.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { DatabaseLive } from "../src/database.ts";

const makeRepoLayer = (storageDirectory: string) =>
  ChannelStateRepository.layer.pipe(
    Layer.provideMerge(DatabaseLive),
    Layer.provide(Layer.succeed(AppConfig, { storageDirectory } as AppConfigShape)),
    Layer.provide(NodeServices.layer),
  );

describe("channel state", () => {
  it.effect("loads defaults for missing channel", () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    return Effect.gen(function* () {
      const repo = yield* ChannelStateRepository;
      expect(yield* repo.getActiveSession("123")).toBeUndefined();
      expect(yield* repo.getShowThinking("123")).toBe(false);
    }).pipe(Effect.provide(makeRepoLayer(dir)));
  });

  it.effect("persists flattened fields", () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    return Effect.gen(function* () {
      const repo = yield* ChannelStateRepository;
      yield* repo.setActiveSession("456", "session.json");
      yield* repo.setShowThinking("456", true);

      expect(yield* repo.getActiveSession("456")).toBe("session.json");
      expect(yield* repo.getShowThinking("456")).toBe(true);
      yield* Effect.promise(() =>
        expect(access(join(dir, "bubblebuddy.sqlite"))).resolves.toBeUndefined(),
      );
    }).pipe(Effect.provide(makeRepoLayer(dir)));
  });

  it.effect("clears default-valued fields from storage", () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    return Effect.gen(function* () {
      const repo = yield* ChannelStateRepository;
      yield* repo.setActiveSession("789", "session.json");
      yield* repo.setShowThinking("789", true);
      yield* repo.clearActiveSession("789");
      yield* repo.setShowThinking("789", false);

      expect(yield* repo.getActiveSession("789")).toBeUndefined();
      expect(yield* repo.getShowThinking("789")).toBe(false);
    }).pipe(Effect.provide(makeRepoLayer(dir)));
  });
});
