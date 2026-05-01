import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  SessionManager,
  type AuthStorage,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { Effect, Fiber, Schedule } from "effect";
import type { Api, Model } from "@mariozechner/pi-ai";

import { FileSystemChannelRepository, type ChannelRepository } from "./channel-repository.ts";
import type { AppConfigShape } from "./config.ts";
import { createSessionSink } from "./discord/session-sink.ts";
import type { PromptTemplateContext } from "./domain/prompt.ts";
import { PiChannelSession } from "./pi/channel-session.ts";
import { WORKSPACE_CWD } from "./pi/workspace.ts";
import { SerialExecutor } from "./util/serial-executor.ts";
import { ChannelState } from "./channel-state.ts";

const SWEEP_INTERVAL = "30 seconds";

export interface SessionFactoryInput {
  readonly channel: GuildTextBasedChannel;
  readonly originMessage: Message<true>;
  readonly promptContext: PromptTemplateContext;
}

export interface ChannelSessionManager {
  readonly activate: (input: SessionFactoryInput, messageText: string) => Promise<void>;
  readonly compact: (
    input: SessionFactoryInput,
    customInstructions?: string,
  ) => Promise<"started" | "no-session" | "rejected-busy" | "rejected-compacting">;
  readonly discard: (channelId: string) => Promise<"discarded" | "rejected-busy">;
  readonly withChannel: <T>(
    channelId: string,
    fn: (channel: ChannelState) => Promise<T>,
  ) => Promise<T>;
  readonly shutdown: () => Promise<void>;
}

export interface ChannelSessionManagerOptions {
  readonly agentDir: string;
  readonly authStorage: AuthStorage;
  readonly config: AppConfigShape;
  readonly model: Model<Api>;
  readonly modelRegistry: ModelRegistry;
}

export class ChannelSessionManagerImpl implements ChannelSessionManager {
  readonly #agentDir: string;
  readonly #authStorage: AuthStorage;
  readonly #config: AppConfigShape;
  readonly #model: Model<Api>;
  readonly #modelRegistry: ModelRegistry;
  readonly #channels = new Map<string, ChannelState>();
  readonly #locks = new Map<string, SerialExecutor>();
  readonly #activeOperations = new Set<Promise<unknown>>();
  readonly #repository: ChannelRepository;
  readonly #idleTimeoutMs: number;
  readonly #sweeper: Fiber.Fiber<void, never>;
  #isShuttingDown = false;

  constructor(options: ChannelSessionManagerOptions) {
    this.#agentDir = options.agentDir;
    this.#authStorage = options.authStorage;
    this.#config = options.config;
    this.#model = options.model;
    this.#modelRegistry = options.modelRegistry;
    this.#repository = new FileSystemChannelRepository(options.config.storageDirectory);
    this.#idleTimeoutMs = options.config.channelIdleTimeoutMs;
    this.#sweeper = Effect.runFork(this.#runSweeper());
  }

  activate(input: SessionFactoryInput, messageText: string): Promise<void> {
    return this.#trackOperation(
      this.#lockFor(input.channel.id).run(async () => {
        if (this.#isShuttingDown) {
          return;
        }

        const channel = await this.#getOrLoadChannel(input.channel.id);
        if (this.#isShuttingDown) {
          await this.#closeChannel(input.channel.id, "shutdown");
          return;
        }

        if (!channel.hasSession) {
          const { pi, sessionManager } = await this.#createPiSession(input, channel);
          channel.attachSession(pi);

          const sessionFile = sessionManager.getSessionFile();
          if (sessionFile !== undefined) {
            const newActiveSession = basename(sessionFile);
            if (channel.activeSession !== newActiveSession) {
              channel.setActiveSession(newActiveSession);
            }
          }

          await channel.persistIfDirty();
        }

        if (this.#isShuttingDown) {
          await this.#closeChannel(input.channel.id, "shutdown");
          return;
        }

        await channel.activateSession(messageText, input.originMessage.id);
      }),
    );
  }

  compact(
    input: SessionFactoryInput,
    customInstructions?: string,
  ): Promise<"started" | "no-session" | "rejected-busy" | "rejected-compacting"> {
    const channelId = input.channel.id;
    return this.#trackOperation(
      this.#lockFor(channelId).run(async () => {
        const channel = await this.#getOrLoadChannel(channelId);

        if (channel.isCompacting) {
          return "rejected-compacting";
        }
        if (channel.isStreaming || channel.isRetrying) {
          return "rejected-busy";
        }
        if (!channel.hasSession) {
          if (channel.activeSession === undefined) {
            return "no-session";
          }

          const { pi } = await this.#createPiSession(input, channel);
          channel.attachSession(pi);
        }

        channel.touchActivity();

        await channel.requestCompaction(customInstructions);

        return "started";
      }),
    );
  }

  discard(channelId: string): Promise<"discarded" | "rejected-busy"> {
    return this.#trackOperation(
      this.#lockFor(channelId).run(async () => {
        const channel = await this.#getOrLoadChannel(channelId);

        if (channel.isStreaming || channel.isCompacting || channel.isRetrying) {
          void Effect.runFork(
            Effect.logInfo(`Session discard rejected for channel ${channelId}: session is busy.`),
          );
          return "rejected-busy";
        }

        await this.#closeChannel(channelId, "dispose");
        return "discarded";
      }),
    );
  }

  withChannel<T>(channelId: string, fn: (channel: ChannelState) => Promise<T>): Promise<T> {
    return this.#trackOperation(
      this.#lockFor(channelId).run(async () => {
        const channel = await this.#getOrLoadChannel(channelId);
        const result = await fn(channel);
        await channel.persistIfDirty();
        return result;
      }),
    );
  }

  async shutdown(): Promise<void> {
    this.#isShuttingDown = true;
    void Effect.runFork(Effect.logInfo("Channel session shutdown started."));
    await Effect.runPromise(Fiber.interrupt(this.#sweeper)).catch(() => undefined);
    await Promise.allSettled(this.#activeOperations);

    const channelIds = [...this.#channels.keys()];
    await Promise.allSettled(
      channelIds.map((id) =>
        this.#trackOperation(this.#lockFor(id).run(() => this.#closeChannel(id, "shutdown"))),
      ),
    );

    void Effect.runFork(Effect.logInfo("Channel session shutdown complete."));
  }

  get channelCount(): number {
    return this.#channels.size;
  }

  async #getOrLoadChannel(channelId: string): Promise<ChannelState> {
    const existing = this.#channels.get(channelId);
    if (existing !== undefined) {
      existing.touchActivity();
      return existing;
    }

    const channel = await ChannelState.load(channelId, this.#repository);
    this.#channels.set(channelId, channel);
    return channel;
  }

  async #createPiSession(
    input: SessionFactoryInput,
    channel: ChannelState,
  ): Promise<{ pi: PiChannelSession; sessionManager: SessionManager }> {
    await mkdir(this.#workspaceDir(input.channel.id), { recursive: true });
    const sessionManager = await this.#loadSessionManager(input.channel.id, channel.activeSession);

    const sink = createSessionSink(input.channel, this.#config, channel);

    const pi = await Effect.runPromise(
      PiChannelSession.create({
        agentDir: this.#agentDir,
        authStorage: this.#authStorage,
        botProfile: this.#config.botProfile,
        discordContextTemplate: this.#config.discordContextTemplate,
        enableAgenticWorkspace: this.#config.enableAgenticWorkspace,
        getChannelSettings: () => channel.settings,
        hostWorkspaceDir: this.#workspaceDir(input.channel.id),
        model: this.#model,
        mcpServers: this.#config.mcpServers,
        modelRegistry: this.#modelRegistry,
        originMessage: input.originMessage,
        promptContext: input.promptContext,
        sessionManager,
        sink,
        thinkingLevel: this.#config.thinkingLevel,
      }),
    );

    return { pi, sessionManager };
  }

  async #loadSessionManager(channelId: string, activeSession?: string): Promise<SessionManager> {
    const sessionsDir = this.#sessionsDir(channelId);
    await mkdir(sessionsDir, { recursive: true });

    if (activeSession !== undefined) {
      try {
        return SessionManager.open(join(sessionsDir, activeSession), sessionsDir, WORKSPACE_CWD);
      } catch (error) {
        void Effect.runFork(
          Effect.logWarning(
            `Failed to resume session for channel ${channelId} from ${activeSession}. Starting a new session.`,
            error,
          ),
        );
      }
    }

    return SessionManager.create(WORKSPACE_CWD, sessionsDir);
  }

  async #closeChannel(channelId: string, mode: "dispose" | "shutdown"): Promise<void> {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) {
      return;
    }

    if (mode === "dispose") {
      await channel.detachAndClearSession();
    } else {
      await channel.shutdownSession();
    }

    await channel.persistIfDirty();
    this.#channels.delete(channelId);
    this.#locks.delete(channelId);
  }

  // Visible for testing
  async _sweepChannel(channelId: string, now: number): Promise<void> {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) return;

    await channel.persistIfDirty();

    if (
      now - channel.lastActivity > this.#idleTimeoutMs &&
      !channel.isStreaming &&
      !channel.isCompacting &&
      !channel.isRetrying
    ) {
      await this.#closeChannel(channelId, "shutdown");
    }
  }

  #runSweeper(): Effect.Effect<void> {
    return Effect.repeat(
      Effect.gen({ self: this }, function* () {
        const now = Date.now();
        const channelIds = [...this.#channels.keys()];
        for (const channelId of channelIds) {
          // Work around Effect tsgo false-positive TS2683 on `this` in directly yielded expressions: https://github.com/Effect-TS/tsgo/issues/173
          const sweepChannel = Effect.tryPromise(() =>
            this.#trackOperation(
              this.#lockFor(channelId).run(() => this._sweepChannel(channelId, now)),
            ),
          );
          yield* sweepChannel;
        }
      }).pipe(Effect.ignore({ log: "Warn", message: "Channel sweeper iteration failed" })),
      Schedule.spaced(SWEEP_INTERVAL).pipe(Schedule.while(() => !this.#isShuttingDown)),
    );
  }

  #channelStorageDirectory(channelId: string): string {
    return join(this.#config.storageDirectory, "channel", channelId);
  }

  #workspaceDir(channelId: string): string {
    return join(this.#channelStorageDirectory(channelId), "workspace");
  }

  #sessionsDir(channelId: string): string {
    return join(this.#channelStorageDirectory(channelId), "sessions");
  }

  #trackOperation<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      this.#activeOperations.delete(tracked);
    });
    this.#activeOperations.add(tracked);
    return tracked;
  }

  #lockFor(channelId: string): SerialExecutor {
    let lock = this.#locks.get(channelId);
    if (lock === undefined) {
      lock = new SerialExecutor();
      this.#locks.set(channelId, lock);
    }
    return lock;
  }
}

export const createChannelSessionManager = (
  options: ChannelSessionManagerOptions,
): ChannelSessionManager => new ChannelSessionManagerImpl(options);
