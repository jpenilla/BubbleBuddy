import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSystemChannelRepository } from "../src/channel-repository.ts";
import { ChannelState } from "../src/channel-state.ts";

describe("channel state", () => {
  test("loads empty state for missing channel", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    const repo = new FileSystemChannelRepository(dir);
    const state = await ChannelState.load("123", repo);

    expect(state.activeSession).toBeUndefined();
    expect(state.settings).toEqual({});
    expect(state.lastActivity).toBeGreaterThan(0);
    expect(state.hasSession).toBe(false);
    expect(state.isRunning).toBe(false);
  });

  test("persists settings when dirty", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    const repo = new FileSystemChannelRepository(dir);
    const state = await ChannelState.load("456", repo);

    state.modifySettings((s) => {
      s.showThinking = false;
    });
    await state.persistIfDirty();

    const state2 = await ChannelState.load("456", repo);
    expect(state2.settings.showThinking).toBe(false);
  });

  test("persistIfDirty is a no-op when clean", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    const repo = new FileSystemChannelRepository(dir);
    const state = await ChannelState.load("789", repo);
    await state.persistIfDirty();

    const filePath = join(dir, "channel", "789", "channel.json");
    let threw = false;
    try {
      await readFile(filePath, "utf8");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("touchActivity updates lastActivity", async () => {
    const dir = join(tmpdir(), `bb-test-${Date.now()}`);
    const repo = new FileSystemChannelRepository(dir);
    const state = await ChannelState.load("abc", repo);
    const before = state.lastActivity;
    await new Promise((r) => setTimeout(r, 10));
    state.touchActivity();
    expect(state.lastActivity).toBeGreaterThan(before);
  });
});
