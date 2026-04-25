import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "discord.js";
import { Cause, Effect, Fiber, Option, Queue } from "effect";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@mariozechner/pi-ai";

import type { ToolStatusEmbed } from "../discord/tool-status-embed.ts";
import { createDiscordTools } from "../discord/tools.ts";
import { extractAssistantText } from "../domain/text.ts";
import { SHOW_THINKING_DEFAULT, type ChannelSettings } from "../channel-repository.ts";
import { SerialExecutor } from "../util/serial-executor.ts";
import type { ThinkingLevel } from "../config.ts";
import type { PromptTemplateContext } from "../domain/prompt.ts";
import { createChannelWorkspaceResourceLoader } from "./channel-workspace-resource-loader.ts";
import { createGondolinExtension } from "./gondolin-extension.ts";
import { createPromptComposerExtension } from "./prompt-extension.ts";
import { WORKSPACE_CWD } from "./workspace.ts";

export interface SessionSink {
  readonly onError: (text: string) => Promise<void>;
  readonly onFinal: (text: string, replyToMessageId: string) => Promise<void>;
  readonly onRunEnd: () => Promise<void>;
  readonly onRunStart: () => Promise<void>;
  readonly onStatus: (status: ToolStatusEmbed) => Promise<void>;
  readonly onThinking: (text: string) => Promise<void>;
}

export interface PiChannelSessionOptions {
  readonly agentDir: string;
  readonly authStorage: AuthStorage;
  readonly botProfile: string;
  readonly discordContextTemplate: string;
  readonly getChannelSettings: () => Readonly<ChannelSettings>;
  readonly hostWorkspaceDir: string;
  readonly enableAgenticWorkspace: boolean;
  readonly model: Model<Api>;
  readonly modelRegistry: ModelRegistry;
  readonly originMessage: Message<true>;
  readonly promptContext: PromptTemplateContext;
  readonly sessionManager: SessionManager;
  readonly sink: SessionSink;
  readonly thinkingLevel: ThinkingLevel;
}

type AgentSessionInstance = Awaited<ReturnType<typeof createAgentSession>>["session"];
type DiscordAction = () => Promise<void>;
type RunDiscordAction = <T>(operation: () => Promise<T>) => Promise<T>;

const SHUTDOWN_ABORT_TIMEOUT = "8 seconds";

const SUPPRESSED_TOOL_STATUS = new Set([
  "discord_list_custom_emojis",
  "discord_list_stickers",
  "discord_fetch_message",
  "discord_react",
  "discord_send_sticker",
  "discord_upload_file",
]);

export class PiChannelSession {
  readonly #executor = new SerialExecutor();
  readonly #statusQueue: Queue.Queue<DiscordAction>;
  readonly #mutationQueue: Queue.Queue<DiscordAction>;
  readonly #discordWorker: Fiber.Fiber<void, never>;
  readonly #session: AgentSessionInstance;
  readonly #sink: SessionSink;
  readonly #unsubscribe: () => void;
  readonly #getChannelSettings: () => Readonly<ChannelSettings>;
  readonly #workspaceDispose?: () => Promise<void>;
  #disposePromise?: Promise<void>;
  #isDisposed = false;
  #isShuttingDown = false;
  #latestAssistantText?: string;
  #replyToMessageId: string;

  private constructor(
    session: AgentSessionInstance,
    sink: SessionSink,
    statusQueue: Queue.Queue<DiscordAction>,
    mutationQueue: Queue.Queue<DiscordAction>,
    initialReplyToMessageId: string,
    getChannelSettings: () => Readonly<ChannelSettings>,
    workspaceDispose?: () => Promise<void>,
  ) {
    this.#statusQueue = statusQueue;
    this.#mutationQueue = mutationQueue;
    this.#discordWorker = Effect.runFork(this.#runDiscordWorker());
    this.#session = session;
    this.#replyToMessageId = initialReplyToMessageId;
    this.#sink = sink;
    this.#getChannelSettings = getChannelSettings;
    this.#workspaceDispose = workspaceDispose;
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
            if (this.#getChannelSettings().showThinking ?? SHOW_THINKING_DEFAULT) {
              const thinking = event.assistantMessageEvent.content.trim();
              if (thinking.length > 0) {
                this.#enqueueStatusAction(() => this.#sink.onThinking(thinking));
              }
            }
          }
          break;
        case "tool_execution_end":
        case "tool_execution_start":
          if (!SUPPRESSED_TOOL_STATUS.has(event.toolName)) {
            this.#enqueueStatusAction(() =>
              this.#sink.onStatus({
                phase:
                  event.type === "tool_execution_start"
                    ? "start"
                    : event.isError
                      ? "error"
                      : "success",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              }),
            );
          }
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
    const settingsManager = SettingsManager.inMemory({
      steeringMode: "all",
      followUpMode: "all",
    });
    const extensionFactories: ExtensionFactory[] = [
      createPromptComposerExtension({
        botProfile: options.botProfile,
        discordContextTemplate: options.discordContextTemplate,
        enableAgenticWorkspace: options.enableAgenticWorkspace,
        promptContext: options.promptContext,
      }),
    ];

    let workspaceDispose: (() => Promise<void>) | undefined;
    if (options.enableAgenticWorkspace) {
      const gondolin = createGondolinExtension({
        channelId: options.originMessage.channelId,
        sessionCwd: WORKSPACE_CWD,
        sessionLabel: `bubblebuddy:${options.originMessage.channelId}`,
        workspaceDir: options.hostWorkspaceDir,
      });
      extensionFactories.push(gondolin.extensionFactory);
      workspaceDispose = gondolin.dispose;
    }

    const resourceLoader = createChannelWorkspaceResourceLoader({
      agentDir: options.agentDir,
      enableAgenticWorkspace: options.enableAgenticWorkspace,
      extensionFactories,
      settingsManager,
      workspaceDir: options.hostWorkspaceDir,
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

    const discordTools = createDiscordTools(options.originMessage, runDiscordAction, {
      enableAgenticWorkspace: options.enableAgenticWorkspace,
      workspaceDir: options.hostWorkspaceDir,
    });
    const { session } = await createAgentSession({
      agentDir: options.agentDir,
      authStorage: options.authStorage,
      customTools: discordTools,
      cwd: WORKSPACE_CWD,
      model: options.model,
      modelRegistry: options.modelRegistry,
      resourceLoader,
      sessionManager: options.sessionManager,
      settingsManager,
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
      options.getChannelSettings,
      workspaceDispose,
    );
  }

  get isRunning(): boolean {
    return this.#session.isStreaming;
  }

  activate(input: string, replyToMessageId: string): Promise<void> {
    return this.#executor.run(async () => {
      this.#replyToMessageId = replyToMessageId;

      if (this.#session.isStreaming) {
        await this.#session.steer(input);
        return;
      }

      void this.#session.prompt(input).catch((error) => {
        if (!this.#isShuttingDown) {
          this.#enqueueStatusAction(() => this.#sink.onError(this.#formatUnexpectedError(error)));
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.#isDisposed) {
      return;
    }

    this.#isShuttingDown = true;

    await this.#abortForShutdown();
    if (this.#session.isStreaming) {
      this.#enqueueStatusAction(() => this.#sink.onRunEnd());
    }
    await this.#drainDiscordActions();
    await this.dispose();
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #abortForShutdown(): Promise<void> {
    await Effect.runPromise(
      Effect.tryPromise(() => this.#session.abort()).pipe(
        Effect.timeout(SHUTDOWN_ABORT_TIMEOUT),
        Effect.catch(() => Effect.void),
      ),
    );
  }

  async #dispose(): Promise<void> {
    if (this.#isDisposed) {
      return;
    }

    this.#isDisposed = true;
    this.#unsubscribe();
    Effect.runSync(Queue.shutdown(this.#statusQueue));
    Effect.runSync(Queue.shutdown(this.#mutationQueue));
    await Effect.runPromise(Fiber.interrupt(this.#discordWorker)).catch(() => undefined);
    this.#session.dispose();
    await this.#workspaceDispose?.().catch(() => undefined);
  }

  async #drainDiscordActions(): Promise<void> {
    await Promise.all([
      new Promise<void>((resolve) => {
        if (!this.#offerDiscordAction(this.#statusQueue, async () => resolve())) {
          resolve();
        }
      }),
      new Promise<void>((resolve) => {
        if (!this.#offerDiscordAction(this.#mutationQueue, async () => resolve())) {
          resolve();
        }
      }),
    ]);
  }

  #enqueueStatusAction(action: DiscordAction): void {
    this.#offerDiscordAction(this.#statusQueue, action);
  }

  #offerDiscordAction(queue: Queue.Queue<DiscordAction>, action: DiscordAction): boolean {
    try {
      return Effect.runSync(Queue.offer(queue, action));
    } catch {
      return false;
    }
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
      if (!this.#isShuttingDown) {
        await this.#sink.onError(lastMessage.errorMessage ?? "The model request failed.");
      } else if (latestAssistantText !== undefined) {
        await this.#sink.onFinal(latestAssistantText, replyToMessageId);
      }
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
