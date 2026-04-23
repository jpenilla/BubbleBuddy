import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  SessionManager,
  type AuthStorage,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "discord.js";
import type { Api, Model } from "@mariozechner/pi-ai";

import type { AppConfigShape } from "./config.ts";
import type { PromptTemplateContext } from "./domain/prompt.ts";
import {
  PiChannelSession,
  type SessionActivationResult,
  type SessionSink,
} from "./pi/channel-session.ts";

const ACTIVE_SESSION_FILE_NAME = "active_session";

export interface SessionFactoryInput {
  readonly channelId: string;
  readonly originMessage: Message<true>;
  readonly promptContext: PromptTemplateContext;
  readonly sink: SessionSink;
}

export interface ChannelSessions {
  readonly activate: (
    input: SessionFactoryInput,
    messageText: string,
  ) => Promise<SessionActivationResult>;
  readonly discard: (channelId: string) => Promise<"discarded" | "rejected-busy">;
  readonly isBusy: (channelId: string) => boolean;
  readonly waitForSettled: () => Promise<void>;
}

export interface ChannelSessionsOptions {
  readonly agentDir: string;
  readonly authStorage: AuthStorage;
  readonly config: AppConfigShape;
  readonly cwd: string;
  readonly model: Model<Api>;
  readonly modelRegistry: ModelRegistry;
}

class SerialExecutor {
  #tail = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

class ChannelSessionsLiveImpl implements ChannelSessions {
  readonly #agentDir: string;
  readonly #authStorage: AuthStorage;
  readonly #config: AppConfigShape;
  readonly #cwd: string;
  readonly #model: Model<Api>;
  readonly #modelRegistry: ModelRegistry;
  readonly #sessions = new Map<string, PiChannelSession>();
  readonly #locks = new Map<string, SerialExecutor>();

  constructor(options: ChannelSessionsOptions) {
    this.#agentDir = options.agentDir;
    this.#authStorage = options.authStorage;
    this.#config = options.config;
    this.#cwd = options.cwd;
    this.#model = options.model;
    this.#modelRegistry = options.modelRegistry;
  }

  activate(input: SessionFactoryInput, messageText: string): Promise<SessionActivationResult> {
    return this.#lockFor(input.channelId).run(async () => {
      const session = this.#sessions.get(input.channelId) ?? (await this.#createSession(input));

      return session.activate(messageText, input.originMessage.id);
    });
  }

  discard(channelId: string): Promise<"discarded" | "rejected-busy"> {
    return this.#lockFor(channelId).run(async () => {
      const session = this.#sessions.get(channelId);
      if (session === undefined) {
        await this.#clearActiveSessionReference(channelId);
        return "discarded";
      }

      if (!(await session.discardIfIdle())) {
        return "rejected-busy";
      }

      session.dispose();
      this.#sessions.delete(channelId);
      await this.#clearActiveSessionReference(channelId);
      return "discarded";
    });
  }

  isBusy(channelId: string): boolean {
    return this.#sessions.get(channelId)?.isBusy ?? false;
  }

  async waitForSettled(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((session) => session.waitForSettled()));
  }

  async #createSession(input: SessionFactoryInput): Promise<PiChannelSession> {
    const sessionManager = await this.#loadSessionManager(input.channelId);
    const session = await PiChannelSession.create({
      agentDir: this.#agentDir,
      authStorage: this.#authStorage,
      botProfile: this.#config.botProfile,
      cwd: this.#cwd,
      discordContextTemplate: this.#config.discordContextTemplate,
      enableAgenticWorkspace: this.#config.enableAgenticWorkspace,
      model: this.#model,
      modelRegistry: this.#modelRegistry,
      originMessage: input.originMessage,
      promptContext: input.promptContext,
      sessionManager,
      sink: input.sink,
      thinkingLevel: this.#config.thinkingLevel,
    });

    await this.#writeActiveSessionReference(input.channelId, sessionManager);
    this.#sessions.set(input.channelId, session);
    return session;
  }

  async #loadSessionManager(channelId: string): Promise<SessionManager> {
    const sessionsDir = this.#sessionsDir(channelId);
    await mkdir(sessionsDir, { recursive: true });

    const activeSessionReference = await this.#readActiveSessionReference(channelId);
    if (activeSessionReference !== undefined) {
      try {
        return SessionManager.open(
          join(sessionsDir, activeSessionReference),
          sessionsDir,
          this.#cwd,
        );
      } catch (error) {
        console.warn(
          `Failed to resume session for channel ${channelId} from ${activeSessionReference}. Starting a new session.`,
          error,
        );
      }
    }

    return SessionManager.create(this.#cwd, sessionsDir);
  }

  async #readActiveSessionReference(channelId: string): Promise<string | undefined> {
    try {
      const activeSessionReference = await readFile(
        this.#activeSessionReferencePath(channelId),
        "utf8",
      );
      const trimmed = activeSessionReference.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  async #writeActiveSessionReference(
    channelId: string,
    sessionManager: SessionManager,
  ): Promise<void> {
    const sessionFile = sessionManager.getSessionFile();
    if (sessionFile === undefined) {
      throw new Error(`Persistent session file was not created for channel ${channelId}.`);
    }

    await mkdir(this.#channelStorageDirectory(channelId), { recursive: true });
    await writeFile(
      this.#activeSessionReferencePath(channelId),
      `${basename(sessionFile)}\n`,
      "utf8",
    );
  }

  async #clearActiveSessionReference(channelId: string): Promise<void> {
    await rm(this.#activeSessionReferencePath(channelId), { force: true });
  }

  #channelStorageDirectory(channelId: string): string {
    return join(this.#config.storageDirectory, "channel", channelId);
  }

  #sessionsDir(channelId: string): string {
    return join(this.#channelStorageDirectory(channelId), "sessions");
  }

  #activeSessionReferencePath(channelId: string): string {
    return join(this.#channelStorageDirectory(channelId), ACTIVE_SESSION_FILE_NAME);
  }

  #lockFor(channelId: string): SerialExecutor {
    const existing = this.#locks.get(channelId);
    if (existing !== undefined) {
      return existing;
    }

    const created = new SerialExecutor();
    this.#locks.set(channelId, created);
    return created;
  }
}

export const createChannelSessions = (options: ChannelSessionsOptions): ChannelSessions =>
  new ChannelSessionsLiveImpl(options);
