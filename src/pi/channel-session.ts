import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "discord.js";
import { Data, Effect, Exit, Scope } from "effect";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import { createDiscordTools } from "../discord/tools.ts";
import type { ChannelSettings } from "../channel-repository.ts";
import { McpAdapter } from "../mcp/adapter.ts";
import { SerialExecutor } from "../util/serial-executor.ts";
import type { McpServerConfigEntry, ThinkingLevel } from "../config.ts";
import type { PromptTemplateContext } from "../domain/prompt.ts";
import { createChannelWorkspaceResourceLoader } from "./channel-workspace-resource-loader.ts";
import { createGondolinExtension } from "./gondolin-extension.ts";
import { DiscordOutputPump, type SessionSink } from "./discord-output-pump.ts";
import { createPromptComposerExtension } from "./prompt-extension.ts";
import { WORKSPACE_CWD } from "./workspace.ts";

export interface PiChannelSessionOptions {
  readonly agentDir: string;
  readonly authStorage: AuthStorage;
  readonly botProfile: string;
  readonly discordContextTemplate: string;
  readonly getChannelSettings: () => Readonly<ChannelSettings>;
  readonly hostWorkspaceDir: string;
  readonly enableAgenticWorkspace: boolean;
  readonly mcpServers: Record<string, McpServerConfigEntry>;
  readonly model: Model<Api>;
  readonly modelRegistry: ModelRegistry;
  readonly originMessage: Message<true>;
  readonly promptContext: PromptTemplateContext;
  readonly sessionManager: SessionManager;
  readonly sink: SessionSink;
  readonly thinkingLevel: ThinkingLevel;
}

const SHUTDOWN_ABORT_TIMEOUT = "8 seconds";

class ChannelSessionInitError extends Data.TaggedError("ChannelSessionInitError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PiChannelSession {
  readonly #executor = new SerialExecutor();
  readonly #output: DiscordOutputPump;
  readonly #session: AgentSession;
  readonly #scope: Scope.Closeable;
  #pendingQueue: Array<{ text: string; replyToMessageId: string }> = [];
  #isDisposed = false;
  #isShuttingDown = false;

  private constructor(session: AgentSession, output: DiscordOutputPump, scope: Scope.Closeable) {
    this.#output = output;
    this.#session = session;
    this.#scope = scope;
  }

  static create(
    options: PiChannelSessionOptions,
  ): Effect.Effect<PiChannelSession, ChannelSessionInitError> {
    return Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      return yield* PiChannelSession.createInScope(options, scope).pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    });
  }

  private static createInScope(
    options: PiChannelSessionOptions,
    scope: Scope.Closeable,
  ): Effect.Effect<PiChannelSession, ChannelSessionInitError> {
    return Effect.gen(function* () {
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

      if (options.enableAgenticWorkspace) {
        const gondolin = createGondolinExtension({
          channelId: options.originMessage.channelId,
          sessionCwd: WORKSPACE_CWD,
          sessionLabel: `bubblebuddy:${options.originMessage.channelId}`,
          workspaceDir: options.hostWorkspaceDir,
        });
        extensionFactories.push(gondolin.extensionFactory);
        yield* Scope.addFinalizer(
          scope,
          Effect.tryPromise(() => gondolin.dispose()).pipe(
            Effect.ignore({ log: "Warn", message: "Failed to dispose Gondolin workspace" }),
          ),
        );
      }

      const resourceLoader = createChannelWorkspaceResourceLoader({
        agentDir: options.agentDir,
        enableAgenticWorkspace: options.enableAgenticWorkspace,
        extensionFactories,
        settingsManager,
        workspaceDir: options.hostWorkspaceDir,
      });
      yield* Effect.tryPromise({
        try: () => resourceLoader.reload(),
        catch: (error) =>
          new ChannelSessionInitError({
            message: "Failed to reload channel workspace resources",
            cause: error,
          }),
      });

      const output = yield* DiscordOutputPump.make({
        getChannelSettings: options.getChannelSettings,
        initialReplyToMessageId: options.originMessage.id,
        sink: options.sink,
      });

      const discordTools = createDiscordTools(options.originMessage, output.runDiscordAction, {
        enableAgenticWorkspace: options.enableAgenticWorkspace,
        workspaceDir: options.hostWorkspaceDir,
      });

      let mcpTools: ToolDefinition[] = [];
      if (Object.keys(options.mcpServers).length > 0) {
        const mcpAdapter = new McpAdapter({
          servers: Object.entries(options.mcpServers).map(([name, cfg]) => ({ name, ...cfg })),
        });
        mcpTools = yield* mcpAdapter.connect().pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (error) =>
              new ChannelSessionInitError({
                message: "Failed to configure MCP servers",
                cause: error,
              }),
          ),
        );
      }

      const allTools = [...discordTools, ...mcpTools];

      const { session } = yield* Effect.tryPromise({
        try: () =>
          createAgentSession({
            agentDir: options.agentDir,
            authStorage: options.authStorage,
            customTools: allTools,
            cwd: WORKSPACE_CWD,
            model: options.model,
            modelRegistry: options.modelRegistry,
            resourceLoader,
            sessionManager: options.sessionManager,
            settingsManager,
            thinkingLevel: options.thinkingLevel,
          }),
        catch: (error) =>
          new ChannelSessionInitError({ message: "Failed to create agent session", cause: error }),
      });
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => session.dispose()),
      );

      if (!options.enableAgenticWorkspace) {
        session.setActiveToolsByName(allTools.map((tool) => tool.name));
      }

      const piSession = new PiChannelSession(session, output, scope);

      yield* Effect.forkIn(output.run(), scope);
      yield* Scope.addFinalizer(scope, output.shutdownQueues());

      const unsubscribe = session.subscribe((event) => output.handleSessionEvent(event));
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      const unsubscribeInternal = session.subscribe((event) =>
        piSession.#handleSessionEvent(event),
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribeInternal));

      return piSession;
    });
  }

  get isCompacting(): boolean {
    return this.#session.isCompacting;
  }

  get isStreaming(): boolean {
    return this.#session.isStreaming;
  }

  get isRetrying(): boolean {
    return this.#session.isRetrying;
  }

  /**
   * Start compaction and resolve once the session acknowledges it
   * (isCompacting = true). The optional onSettled callback runs after compaction completes.
   */
  requestCompaction(customInstructions?: string, onSettled?: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const unsub = this.#session.subscribe((event) => {
        if (event.type === "compaction_start") {
          unsub();
          resolve();
        }
      });

      this.#executor
        .run(() => this.#session.compact(customInstructions))
        .catch(() => {}) // Output sink handles showing failed compaction in card
        .finally(() => {
          unsub();
          resolve();
          onSettled?.();
        });
    });
  }

  activate(input: string, replyToMessageId: string): Promise<void> {
    return this.#executor.run(async () => {
      this.#output.setReplyToMessageId(replyToMessageId);

      if (this.#session.isStreaming) {
        await this.#session.steer(input);
        return;
      }

      if (this.#session.isCompacting) {
        this.#pendingQueue.push({ text: input, replyToMessageId });
        return;
      }

      if (this.#session.isRetrying) {
        await this.#session.steer(input);
        return;
      }

      void this.#session.prompt(input).catch((error) => {
        this.#output.enqueueUnexpectedError(error);
      });
    });
  }

  shutdown(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.#isDisposed || this.#isShuttingDown) {
        return;
      }

      this.#isShuttingDown = true;
      this.#output.setShuttingDown(true);

      yield* this.#abortForShutdown();
      this.#session.abortCompaction();
      this.#output.enqueueRunEnd(); // Ensure typing indicator shuts down, even in edge-case error states
      yield* Effect.yieldNow; // Let abort-triggered microtasks (e.g. compaction_end) flush before draining output
      yield* this.#output.drain();
      yield* this.dispose();
    });
  }

  dispose(): Effect.Effect<void> {
    return Effect.suspend(() => (this.#isDisposed ? Effect.void : this.#dispose()));
  }

  #handleSessionEvent(event: AgentSessionEvent): void {
    if (event.type === "compaction_end") {
      const messages = this.#pendingQueue;
      this.#pendingQueue = [];
      if (messages.length === 0) return;

      for (const { text, replyToMessageId } of messages) {
        this.#output.setReplyToMessageId(replyToMessageId);
        this.#session.steer(text);
      }

      if (event.result === undefined && !event.willRetry) {
        this.#session.agent.continue();
      }
    }
  }

  #abortForShutdown(): Effect.Effect<void> {
    return Effect.tryPromise(() => this.#session.abort()).pipe(
      Effect.timeout(SHUTDOWN_ABORT_TIMEOUT),
      Effect.ignore({ log: "Warn", message: "Session abort for shutdown failed" }),
    );
  }

  #dispose(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.#isDisposed = true;
      // Work around Effect tsgo false-positive TS2683 on `this` in directly yielded expressions: https://github.com/Effect-TS/tsgo/issues/173
      const scope = this.#scope;
      yield* Scope.close(scope, Exit.void);
    });
  }
}
