import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { ChannelRepository } from "../src/channel-repository.ts";
import { loadChannelState } from "../src/channel-state.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";

const makeRepoLayer = (storageDirectory: string) =>
  ChannelRepository.layer.pipe(
    Layer.provide(Layer.succeed(AppConfig, { storageDirectory } as AppConfigShape)),
    Layer.provide(NodeServices.layer),
  );

const loadState = (storageDirectory: string, channelId: string) =>
  Effect.gen(function* () {
    const repo = yield* ChannelRepository;
    return yield* loadChannelState(channelId, repo);
  }).pipe(Effect.provide(makeRepoLayer(storageDirectory)), Effect.runPromise);

describe("channel state", () => {
  test("loads empty state for missing channel", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    const state = await loadState(dir, "123");

    expect(state.activeSession).toBeUndefined();
    expect(state.settings).toEqual({});
  });

  test("persists settings when dirty", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    const state = await loadState(dir, "456");

    state.modifySettings((s) => {
      s.showThinking = false;
    });
    await Effect.runPromise(Effect.provide(state.persistIfDirty(), makeRepoLayer(dir)));

    const state2 = await loadState(dir, "456");
    expect(state2.settings.showThinking).toBe(false);
  });

  test("persistIfDirty is a no-op when clean", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    const state = await loadState(dir, "789");
    await Effect.runPromise(Effect.provide(state.persistIfDirty(), makeRepoLayer(dir)));

    const filePath = join(dir, "channel", "789", "channel.json");
    let threw = false;
    try {
      await readFile(filePath, "utf8");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
