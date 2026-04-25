import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

import { ChannelSessionManagerImpl } from "../src/sessions.ts";
import type { AppConfigShape } from "../src/config.ts";

const makeConfig = (storageDir: string): AppConfigShape => ({
  botProfile: "test",
  channelIdleTimeoutMs: 1,
  discordContextTemplate: "",
  discordToken: "fake",
  enableAgenticWorkspace: false,
  modelId: "test-model",
  modelProvider: "test",
  storageDirectory: storageDir,
  thinkingLevel: "medium",
  typingIndicatorIntervalMs: 1000,
});

describe("channel session manager", () => {
  test("evicts idle channels on sweep", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bb-test-"));
    const manager = new ChannelSessionManagerImpl({
      agentDir: tmpDir,
      authStorage: AuthStorage.create(),
      config: makeConfig(tmpDir),
      model: {} as unknown as Model<never>,
      modelRegistry: {} as unknown as ModelRegistry,
    });

    try {
      await manager.withChannel("ch-1", async (ch) => {
        ch.modifySettings((s) => {
          s.showThinking = false;
        });
      });

      expect(manager.channelCount).toBe(1);

      await manager._sweepChannel("ch-1", Date.now() + 1_000_000);

      expect(manager.channelCount).toBe(0);
    } finally {
      await manager.shutdown();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("withChannel persists dirty state", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bb-test-"));
    const manager = new ChannelSessionManagerImpl({
      agentDir: tmpDir,
      authStorage: AuthStorage.create(),
      config: makeConfig(tmpDir),
      model: {} as unknown as Model<never>,
      modelRegistry: {} as unknown as ModelRegistry,
    });

    try {
      await manager.withChannel("ch-2", async (ch) => {
        ch.modifySettings((s) => {
          s.showThinking = true;
        });
      });

      const state = await manager.withChannel("ch-2", async (ch) => {
        return ch.settings.showThinking;
      });

      expect(state).toBe(true);
      expect(manager.channelCount).toBe(1);
    } finally {
      await manager.shutdown();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
