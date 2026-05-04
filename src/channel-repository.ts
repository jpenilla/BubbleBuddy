import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

const CHANNEL_FILE_NAME = "channel.json";

export const SHOW_THINKING_DEFAULT = false;

export interface ChannelSettings {
  showThinking?: boolean;
}

export interface PersistentChannelState {
  activeSession?: string;
  settings: ChannelSettings;
}

export interface ChannelRepository {
  load(channelId: string): Promise<PersistentChannelState>;
  save(channelId: string, state: PersistentChannelState): Promise<void>;
}

export class FileSystemChannelRepository implements ChannelRepository {
  readonly #storageDirectory: string;

  constructor(storageDirectory: string) {
    this.#storageDirectory = storageDirectory;
  }

  async load(channelId: string): Promise<PersistentChannelState> {
    const path = this.#channelFilePath(channelId);
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as PersistentChannelState;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { settings: {} };
      }
      void Effect.runFork(
        Effect.logWarning(`Failed to load channel state for ${channelId}`, error),
      );
      return { settings: {} };
    }
  }

  async save(channelId: string, state: PersistentChannelState): Promise<void> {
    await mkdir(this.#channelDir(channelId), { recursive: true });
    await writeFile(this.#channelFilePath(channelId), JSON.stringify(state, null, 2), "utf8");
  }

  #channelDir(channelId: string): string {
    return join(this.#storageDirectory, "channel", channelId);
  }

  #channelFilePath(channelId: string): string {
    return join(this.#channelDir(channelId), CHANNEL_FILE_NAME);
  }
}
