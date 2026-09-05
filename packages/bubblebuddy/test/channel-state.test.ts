import { expect, it } from "@effect/vitest";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ChannelStateRepository } from "../src/session/state.ts";
import { AppHome } from "../src/config/env.ts";
import { DatabaseLayer } from "../src/database.ts";
import { createTestEnvLayer } from "./helpers.ts";

const withRepo = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bb-channel-state-" });
    return yield* effect.pipe(
      Effect.provide(
        ChannelStateRepository.layerNoDeps.pipe(
          Layer.provideMerge(DatabaseLayer),
          Layer.provideMerge(AppHome.layerNoDeps),
          Layer.provideMerge(createTestEnvLayer({ appHome: dir })),
        ),
      ),
    );
  });

it.layer(NodeServices.layer)("channel state", (it) => {
  it.effect("loads defaults for missing channel", () =>
    Effect.gen(function* () {
      const repo = yield* ChannelStateRepository;
      expect(yield* repo.getActiveSession("123")).toBeUndefined();
      expect(yield* repo.getShowThinking("123")).toBe(false);
    }).pipe(withRepo),
  );

  it.effect("persists flattened fields", () =>
    Effect.gen(function* () {
      const repo = yield* ChannelStateRepository;
      yield* repo.setActiveSession("456", "session.json");
      yield* repo.setShowThinking("456", true);

      expect(yield* repo.getActiveSession("456")).toBe("session.json");
      expect(yield* repo.getShowThinking("456")).toBe(true);
    }).pipe(withRepo),
  );

  it.effect("clears default-valued fields from storage", () =>
    Effect.gen(function* () {
      const repo = yield* ChannelStateRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* repo.setActiveSession("789", "session.json");
      yield* repo.setShowThinking("789", true);
      yield* repo.clearActiveSession("789");
      yield* repo.setShowThinking("789", false);

      expect(yield* repo.getActiveSession("789")).toBeUndefined();
      expect(yield* repo.getShowThinking("789")).toBe(false);
      expect(yield* sql`SELECT channel_id FROM channel_sessions WHERE channel_id = '789'`).toEqual(
        [],
      );
      expect(yield* sql`SELECT channel_id FROM channel_settings WHERE channel_id = '789'`).toEqual(
        [],
      );
    }).pipe(withRepo),
  );
});
