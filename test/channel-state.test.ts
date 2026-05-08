import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import type { ChannelState } from "../src/channel-state.ts";
import {
  ChannelStateRepository,
  type ChannelStateRepositoryError,
} from "../src/channel-state-repository.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";

const makeRepoLayer = (storageDirectory: string) =>
  ChannelStateRepository.layer.pipe(
    Layer.provide(Layer.succeed(AppConfig, { storageDirectory } as AppConfigShape)),
    Layer.provide(NodeServices.layer),
  );

const withState = <A>(
  storageDirectory: string,
  channelId: string,
  use: (state: ChannelState) => Effect.Effect<A, ChannelStateRepositoryError>,
) =>
  Effect.gen(function* () {
    const repo = yield* ChannelStateRepository;
    const state = yield* repo.getState(channelId);
    return yield* use(state);
  }).pipe(Effect.scoped, Effect.provide(makeRepoLayer(storageDirectory)), Effect.runPromise);

describe("channel state", () => {
  test("loads empty state for missing channel", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    await withState(dir, "123", (state) =>
      Effect.sync(() => {
        expect(state.activeSession).toBeUndefined();
        expect(state.settings).toEqual({});
      }),
    );
  });

  test("persists settings when dirty", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    await withState(dir, "456", (state) =>
      Effect.sync(() => {
        state.modifySettings((s) => {
          s.showThinking = false;
        });
      }),
    );

    await withState(dir, "456", (state) =>
      Effect.sync(() => {
        expect(state.settings.showThinking).toBe(false);
      }),
    );
  });
});
