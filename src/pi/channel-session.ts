import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "discord.js";
import { Effect, Queue } from "effect";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@mariozechner/pi-ai";

import type { ToolStatusEmbed } from "../discord/tool-status-embed.ts";
import { createDiscordTools } from "../discord/tools.ts";
import { extractAssistantText } from "../domain/text.ts";
import type { ThinkingLevel } from "../config.ts";
import type { PromptTemplateContext } from "../domain/prompt.ts";
import { createPromptComposerExtension } from "./prompt-extension.ts";

export interface SessionSink {
  readonly onError: (text: string) => Promise<void>;
  readonly onFinal: (text: string) => Promise<void>;
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
type SinkAction = () => Promise<void>;

export class PiChannelSession {
  readonly #executor = new SerialExecutor();
  readonly #outputQueue: Queue.Queue<SinkAction>;
  readonly #session: AgentSessionInstance;
  readonly #sink: SessionSink;
  readonly #unsubscribe: () => void;
  #activeRun?: Promise<void>;
  #latestAssistantText?: string;

  private constructor(session: AgentSessionInstance, sink: SessionSink) {
    this.#outputQueue = Effect.runSync(Queue.unbounded<SinkAction>());
    this.#session = session;
    this.#sink = sink;
    this.#unsubscribe = this.#session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          this.#latestAssistantText = undefined;
          this.#enqueueOutput(() => this.#sink.onRunStart());
          break;
        case "agent_end": {
          const lastMessage = event.messages.at(-1);
          this.#enqueueOutput(async () => {
            try {
              await this.#flushFinalOutput(
                lastMessage?.role === "assistant" || lastMessage?.role === "toolResult"
                  ? lastMessage
                  : undefined,
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
              this.#enqueueOutput(() => this.#sink.onThinking(thinking));
            }
          }
          break;
        case "tool_execution_end":
          this.#enqueueOutput(() =>
            this.#sink.onStatus({
              phase: "end",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            }),
          );
          break;
        case "tool_execution_start":
          this.#enqueueOutput(() =>
            this.#sink.onStatus({
              phase: "start",
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
    void Effect.runFork(this.#runOutputWorker());
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

    const discordTools = createDiscordTools(options.originMessage);
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

    return new PiChannelSession(session, options.sink);
  }

  get isBusy(): boolean {
    return this.#session.isStreaming;
  }

  activate(input: string): Promise<SessionActivationResult> {
    return this.#executor.run(async () => {
      if (this.#session.isStreaming) {
        await this.#session.steer(input);
        return "steered";
      }

      const run = this.#session.prompt(input).catch((error) => {
        this.#enqueueOutput(() => this.#sink.onError(this.#formatUnexpectedError(error)));
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
    Effect.runSync(Queue.shutdown(this.#outputQueue));
    this.#session.dispose();
  }

  async waitForIdle(): Promise<void> {
    await this.#activeRun;
    await this.#session.agent.waitForIdle();
    await this.#drainOutputQueue();
  }

  #enqueueOutput(action: SinkAction): void {
    void Effect.runSync(Queue.offer(this.#outputQueue, action));
  }

  async #drainOutputQueue(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#enqueueOutput(async () => {
        resolve();
      });
    });
  }

  #runOutputWorker(): Effect.Effect<never, never, never> {
    return Effect.forever(
      Effect.flatMap(Queue.take(this.#outputQueue), (action) =>
        Effect.catchCause(
          Effect.tryPromise(() => action()),
          () => Effect.void,
        ),
      ),
    );
  }

  async #flushFinalOutput(lastMessage?: AssistantMessage | ToolResultMessage): Promise<void> {
    if (
      lastMessage?.role === "assistant" &&
      (lastMessage.stopReason === "aborted" || lastMessage.stopReason === "error")
    ) {
      await this.#sink.onError(lastMessage.errorMessage ?? "The model request failed.");
      return;
    }

    if (this.#latestAssistantText !== undefined) {
      await this.#sink.onFinal(this.#latestAssistantText);
      this.#latestAssistantText = undefined;
    }
  }

  #formatUnexpectedError(error: unknown): string {
    return error instanceof Error && error.message.length > 0
      ? `The model request failed: ${error.message}`
      : "The model request failed.";
  }
}
