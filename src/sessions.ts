import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

import type { AppConfigShape } from "./config.ts";
import type { PromptTemplateContext } from "./domain/prompt.ts";
import {
  PiChannelSession,
  type SessionActivationResult,
  type SessionSink,
} from "./pi/channel-session.ts";

export interface SessionFactoryInput {
  readonly channelId: string;
  readonly promptContext: PromptTemplateContext;
  readonly sessionId: string;
  readonly sink: SessionSink;
}

export interface ChannelSessions {
  readonly activate: (
    input: SessionFactoryInput,
    messageText: string,
  ) => Promise<SessionActivationResult>;
  readonly discard: (channelId: string) => Promise<"discarded" | "rejected-busy">;
  readonly isBusy: (channelId: string) => boolean;
  readonly waitForIdle: () => Promise<void>;
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

      return session.activate(messageText);
    });
  }

  discard(channelId: string): Promise<"discarded" | "rejected-busy"> {
    return this.#lockFor(channelId).run(async () => {
      const session = this.#sessions.get(channelId);
      if (session === undefined) {
        return "discarded";
      }

      if (!(await session.discardIfIdle())) {
        return "rejected-busy";
      }

      session.dispose();
      this.#sessions.delete(channelId);
      return "discarded";
    });
  }

  isBusy(channelId: string): boolean {
    return this.#sessions.get(channelId)?.isBusy ?? false;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((session) => session.waitForIdle()));
  }

  async #createSession(input: SessionFactoryInput): Promise<PiChannelSession> {
    const session = await PiChannelSession.create({
      agentDir: this.#agentDir,
      authStorage: this.#authStorage,
      botProfile: this.#config.botProfile,
      cwd: this.#cwd,
      discordContextTemplate: this.#config.discordContextTemplate,
      enableAgenticWorkspace: this.#config.enableAgenticWorkspace,
      model: this.#model,
      modelRegistry: this.#modelRegistry,
      promptContext: input.promptContext,
      sessionId: input.sessionId,
      sink: input.sink,
      thinkingLevel: this.#config.thinkingLevel,
    });
    this.#sessions.set(input.channelId, session);
    return session;
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
