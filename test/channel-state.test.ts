import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import {
  ChannelStateRepository,
  type ChannelStateRepositoryError,
  type ChannelStateRepositoryShape,
} from "../src/channel-state-repository.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";

const makeRepoLayer = (storageDirectory: string) =>
  ChannelStateRepository.layer.pipe(
    Layer.provide(Layer.succeed(AppConfig, { storageDirectory } as AppConfigShape)),
    Layer.provide(NodeServices.layer),
  );

const withRepo = <A>(
  storageDirectory: string,
  use: (repo: ChannelStateRepositoryShape) => Effect.Effect<A, ChannelStateRepositoryError>,
) =>
  Effect.gen(function* () {
    const repo = yield* ChannelStateRepository;
    return yield* use(repo);
  }).pipe(Effect.provide(makeRepoLayer(storageDirectory)), Effect.runPromise);

describe("channel state", () => {
  test("loads defaults for missing channel", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    await withRepo(dir, (repo) =>
      Effect.gen(function* () {
        expect(yield* repo.getActiveSession("123")).toBeUndefined();
        expect(yield* repo.getShowThinking("123")).toBe(false);
      }),
    );
  });

  test("persists flattened fields", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    await withRepo(dir, (repo) =>
      Effect.gen(function* () {
        yield* repo.setActiveSession("456", "session.json");
        yield* repo.setShowThinking("456", true);
      }),
    );

    await withRepo(dir, (repo) =>
      Effect.gen(function* () {
        expect(yield* repo.getActiveSession("456")).toBe("session.json");
        expect(yield* repo.getShowThinking("456")).toBe(true);
      }),
    );

    const raw = await readFile(join(dir, "channel", "456", "channel.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({
      activeSession: "session.json",
      showThinking: true,
    });
  });

  test("clears default-valued fields from storage", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    await withRepo(dir, (repo) =>
      Effect.gen(function* () {
        yield* repo.setActiveSession("789", "session.json");
        yield* repo.setShowThinking("789", true);
        yield* repo.clearActiveSession("789");
        yield* repo.setShowThinking("789", false);
      }),
    );

    const raw = await readFile(join(dir, "channel", "789", "channel.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({});
  });
});
