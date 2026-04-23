import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "discord.js";
import { Cause, Effect, Fiber, Option, Queue } from "effect";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@mariozechner/pi-ai";

import type { ToolStatusEmbed } from "../discord/tool-status-embed.ts";
import { createDiscordTools } from "../discord/tools.ts";
import { extractAssistantText } from "../domain/text.ts";
import type { ThinkingLevel } from "../config.ts";
import type { PromptTemplateContext } from "../domain/prompt.ts";
import { createPromptComposerExtension } from "./prompt-extension.ts";

export interface SessionSink {
  readonly onError: (text: string) => Promise<void>;
  readonly onFinal: (text: string, replyToMessageId: string) => Promise<void>;
  readonly onRunEnd: () => Promise<void>;
  readonly onRunStart: () => Promise<void>;
  readonly onStatus: (status: ToolStatusEmbed) => Promise<void>;
  readonly onThinking: (text: string) => Promise<void>;
}

export type SessionActivationResult = "started" | "steered";

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

export interface PiChannelSessionOptions {
  readonly agentDir: string;
  readonly authStorage: AuthStorage;
  readonly botProfile: string;
  readonly cwd: string;
  readonly discordContextTemplate: string;
  readonly enableAgenticWorkspace: boolean;
  readonly model: Model<Api>;
  readonly modelRegistry: ModelRegistry;
  readonly originMessage: Message<true>;
  readonly promptContext: PromptTemplateContext;
  readonly sessionId: string;
  readonly sink: SessionSink;
  readonly thinkingLevel: ThinkingLevel;
}

type AgentSessionInstance = Awaited<ReturnType<typeof createAgentSession>>["session"];
type DiscordAction = () => Promise<void>;
type RunDiscordAction = <T>(operation: () => Promise<T>) => Promise<T>;

export class PiChannelSession {
  readonly #executor = new SerialExecutor();
  readonly #statusQueue: Queue.Queue<DiscordAction>;
  readonly #mutationQueue: Queue.Queue<DiscordAction>;
  readonly #discordWorker: Fiber.Fiber<void, never>;
  readonly #session: AgentSessionInstance;
  readonly #sink: SessionSink;
  readonly #unsubscribe: () => void;
  #activeRun?: Promise<void>;
  #latestAssistantText?: string;
  #replyToMessageId: string;

  private constructor(
    session: AgentSessionInstance,
    sink: SessionSink,
    statusQueue: Queue.Queue<DiscordAction>,
    mutationQueue: Queue.Queue<DiscordAction>,
    initialReplyToMessageId: string,
  ) {
    this.#statusQueue = statusQueue;
    this.#mutationQueue = mutationQueue;
    this.#discordWorker = Effect.runFork(this.#runDiscordWorker());
    this.#session = session;
    this.#replyToMessageId = initialReplyToMessageId;
    this.#sink = sink;
    this.#unsubscribe = this.#session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          this.#latestAssistantText = undefined;
          this.#enqueueStatusAction(() => this.#sink.onRunStart());
          break;
        case "agent_end": {
          const lastMessage = event.messages.at(-1);
          const latestAssistantText = this.#latestAssistantText;
          const replyToMessageId = this.#replyToMessageId;
          this.#enqueueStatusAction(async () => {
            try {
              await this.#flushFinalOutput(
                lastMessage?.role === "assistant" || lastMessage?.role === "toolResult"
                  ? lastMessage
                  : undefined,
                latestAssistantText,
                replyToMessageId,
              );
            } finally {
              await this.#sink.onRunEnd();
            }
          });
          break;
        }
        case "message_update":
          if (event.assistantMessageEvent.type === "thinking_end") {
            const thinking = event.assistantMessageEvent.content.trim();
            if (thinking.length > 0) {
              this.#enqueueStatusAction(() => this.#sink.onThinking(thinking));
            }
          }
          break;
        case "tool_execution_end":
        case "tool_execution_start":
          this.#enqueueStatusAction(() =>
            this.#sink.onStatus({
              phase: event.type === "tool_execution_start" ? "start" : "end",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            }),
          );
          break;
        case "turn_end":
          if (event.message.role === "assistant") {
            const assistantText = extractAssistantText(event.message);
            this.#latestAssistantText =
              assistantText.trim().length === 0 ? undefined : assistantText;
          }
          break;
      }
    });
  }

  static async create(options: PiChannelSessionOptions): Promise<PiChannelSession> {
    const resourceLoader = new DefaultResourceLoader({
      agentDir: options.agentDir,
      appendSystemPromptOverride: () => [],
      cwd: options.cwd,
      extensionFactories: [
        createPromptComposerExtension({
          botProfile: options.botProfile,
          discordContextTemplate: options.discordContextTemplate,
          enableAgenticWorkspace: options.enableAgenticWorkspace,
          promptContext: options.promptContext,
        }),
      ],
      noContextFiles: !options.enableAgenticWorkspace,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: !options.enableAgenticWorkspace,
      noThemes: true,
      systemPromptOverride: () => undefined,
    });
    await resourceLoader.reload();

    const statusQueue = Effect.runSync(Queue.unbounded<DiscordAction>());
    const mutationQueue = Effect.runSync(Queue.unbounded<DiscordAction>());

    const runDiscordAction: RunDiscordAction = <T>(operation: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const enqueued = Effect.runSync(
          Queue.offer(mutationQueue, async () => {
            try {
              resolve(await operation());
            } catch (error) {
              reject(error);
            }
          }),
        );

        if (!enqueued) {
          reject(new Error("Discord action queue is unavailable."));
        }
      });

    const discordTools = createDiscordTools(options.originMessage, runDiscordAction);
    const { session } = await createAgentSession({
      agentDir: options.agentDir,
      authStorage: options.authStorage,
      customTools: discordTools,
      cwd: options.cwd,
      model: options.model,
      modelRegistry: options.modelRegistry,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      thinkingLevel: options.thinkingLevel,
    });

    if (!options.enableAgenticWorkspace) {
      session.setActiveToolsByName(discordTools.map((tool) => tool.name));
    }

    return new PiChannelSession(
      session,
      options.sink,
      statusQueue,
      mutationQueue,
      options.originMessage.id,
    );
  }

  get isBusy(): boolean {
    return this.#session.isStreaming;
  }

  activate(input: string, replyToMessageId: string): Promise<SessionActivationResult> {
    return this.#executor.run(async () => {
      this.#replyToMessageId = replyToMessageId;

      if (this.#session.isStreaming) {
        await this.#session.steer(input);
        return "steered";
      }

      const run = this.#session.prompt(input).catch((error) => {
        this.#enqueueStatusAction(() => this.#sink.onError(this.#formatUnexpectedError(error)));
      });
      this.#activeRun = run.finally(() => {
        if (this.#activeRun === run) {
          this.#activeRun = undefined;
        }
      });
      void this.#activeRun;

      return "started";
    });
  }

  discardIfIdle(): Promise<boolean> {
    return this.#executor.run(async () => {
      if (this.#session.isStreaming) {
        return false;
      }

      this.#session.agent.reset();
      return true;
    });
  }

  dispose(): void {
    this.#unsubscribe();
    Effect.runSync(Queue.shutdown(this.#statusQueue));
    Effect.runSync(Queue.shutdown(this.#mutationQueue));
    void Effect.runFork(Fiber.interrupt(this.#discordWorker));
    this.#session.dispose();
  }

  async waitForSettled(): Promise<void> {
    await this.#activeRun;
    await this.#session.agent.waitForIdle();
    await new Promise<void>((resolve) => {
      this.#enqueueStatusAction(async () => {
        resolve();
      });
    });
  }

  #enqueueStatusAction(action: DiscordAction): void {
    void Effect.runSync(Queue.offer(this.#statusQueue, action));
  }

  #runDiscordWorker(): Effect.Effect<void> {
    const statusQueue = this.#statusQueue;
    const mutationQueue = this.#mutationQueue;

    const loop = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        let action = yield* Queue.poll(statusQueue).pipe(Effect.map(Option.getOrNull));
        if (action === null) {
          action = yield* Queue.poll(mutationQueue).pipe(Effect.map(Option.getOrNull));
        }
        if (action === null) {
          action = yield* Effect.raceFirst(Queue.take(statusQueue), Queue.take(mutationQueue)).pipe(
            Effect.catchIf(Cause.isDone, () => Effect.succeed(null)),
          );
          if (action === null) {
            return;
          }
        }

        // Discard Discord sink/action errors so one failed send/edit doesn't stop the worker.
        yield* Effect.catchCause(
          Effect.tryPromise(() => action()),
          () => Effect.void,
        );

        yield* Effect.suspend(loop);
      });

    return loop();
  }

  async #flushFinalOutput(
    lastMessage: AssistantMessage | ToolResultMessage | undefined,
    latestAssistantText: string | undefined,
    replyToMessageId: string,
  ): Promise<void> {
    if (
      lastMessage?.role === "assistant" &&
      (lastMessage.stopReason === "aborted" || lastMessage.stopReason === "error")
    ) {
      await this.#sink.onError(lastMessage.errorMessage ?? "The model request failed.");
      return;
    }

    if (latestAssistantText !== undefined) {
      await this.#sink.onFinal(latestAssistantText, replyToMessageId);
    }
  }

  #formatUnexpectedError(error: unknown): string {
    return error instanceof Error && error.message.length > 0
      ? `The model request failed: ${error.message}`
      : "The model request failed.";
  }
}
