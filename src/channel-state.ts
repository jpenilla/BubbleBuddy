import type {
  ChannelRepository,
  ChannelSettings,
  PersistentChannelState,
} from "./channel-repository.ts";
import { Effect } from "effect";

import type { PiChannelSession } from "./pi/channel-session.ts";

export class ChannelState {
  readonly #channelId: string;
  readonly #repository: ChannelRepository;
  readonly #persistent: PersistentChannelState;
  #pi?: PiChannelSession;
  #dirty = false;
  #lastActivity: number;

  constructor(
    channelId: string,
    repository: ChannelRepository,
    persistent: PersistentChannelState,
  ) {
    this.#channelId = channelId;
    this.#repository = repository;
    this.#persistent = persistent;
    this.#lastActivity = Date.now();
  }

  static async load(channelId: string, repository: ChannelRepository): Promise<ChannelState> {
    const persistent = await repository.load(channelId);
    return new ChannelState(channelId, repository, persistent);
  }

  get hasSession(): boolean {
    return this.#pi !== undefined;
  }

  get isCompacting(): boolean {
    return this.#pi?.isCompacting ?? false;
  }

  get isStreaming(): boolean {
    return this.#pi?.isStreaming ?? false;
  }

  get isRetrying(): boolean {
    return this.#pi?.isRetrying ?? false;
  }

  get settings(): Readonly<ChannelSettings> {
    return this.#persistent.settings;
  }

  get lastActivity(): number {
    return this.#lastActivity;
  }

  get activeSession(): string | undefined {
    return this.#persistent.activeSession;
  }

  attachSession(session: PiChannelSession): void {
    this.#pi = session;
  }

  async activateSession(messageText: string, replyToMessageId: string): Promise<void> {
    if (this.#pi === undefined) {
      throw new Error("No session attached to channel");
    }
    await this.#pi.activate(messageText, replyToMessageId);
  }

  async requestCompaction(customInstructions?: string): Promise<void> {
    if (this.#pi === undefined) {
      throw new Error("No session attached to channel");
    }

    await this.#pi.requestCompaction(customInstructions, () => {
      this.touchActivity();
      this.persistIfDirty();
    });
  }

  /**
   * Detaches the Pi session and clears the active session reference.
   * Marks state dirty; caller must call {@link persistIfDirty} afterwards.
   */
  async detachAndClearSession(): Promise<void> {
    try {
      await Effect.runPromise(this.#pi?.dispose() ?? Effect.void);
    } finally {
      this.#pi = undefined;
    }
    this.clearActiveSession();
  }

  async shutdownSession(): Promise<void> {
    try {
      await Effect.runPromise(this.#pi?.shutdown() ?? Effect.void);
    } finally {
      this.#pi = undefined;
    }
  }

  setActiveSession(sessionFileName: string): void {
    this.#persistent.activeSession = sessionFileName;
    this.#dirty = true;
  }

  clearActiveSession(): void {
    if (this.#persistent.activeSession !== undefined) {
      delete this.#persistent.activeSession;
      this.#dirty = true;
    }
  }

  /** Mutates the live persistent settings object in-place (not a copy). */
  modifySettings(mutator: (draft: ChannelSettings) => void): void {
    mutator(this.#persistent.settings);
    this.#dirty = true;
  }

  touchActivity(): void {
    this.#lastActivity = Date.now();
  }

  async persistIfDirty(): Promise<void> {
    if (!this.#dirty) {
      return;
    }
    await this.#repository.save(this.#channelId, this.#persistent);
    this.#dirty = false;
  }
}
