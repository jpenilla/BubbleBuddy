import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { GuildTextBasedChannel } from "discord.js";
import { Data, Effect, Exit, Scope, Semaphore } from "effect";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import { createDiscordTools } from "../discord/tools.ts";
import type { ChannelSettings } from "../channel-repository.ts";
import { connectMcpServers } from "../mcp/adapter.ts";
import { AppConfig } from "../config.ts";
import type { PromptTemplateContext } from "../domain/prompt.ts";
import { LoadedResources } from "../resources.ts";
import { createChannelWorkspaceResourceLoader } from "./channel-workspace-resource-loader.ts";
import { createGondolinExtension } from "./gondolin-extension.ts";
import { makeDiscordOutputPump, type SessionSink } from "./discord-output-pump.ts";
import { createPromptComposerExtension } from "./prompt-extension.ts";
import { PiContext } from "./context.ts";
import { WORKSPACE_CWD } from "./workspace.ts";

export interface PiChannelSessionOptions {
  readonly channel: GuildTextBasedChannel;
  readonly getChannelSettings: () => Readonly<ChannelSettings>;
  readonly hostWorkspaceDir: string;
  readonly promptContext: PromptTemplateContext;
  readonly sessionManager: SessionManager;
  readonly sink: SessionSink;
}

const SHUTDOWN_ABORT_TIMEOUT = "8 seconds";

export class ChannelSessionInitError extends Data.TaggedError("ChannelSessionInitError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ChannelSessionOperationError extends Data.TaggedError("ChannelSessionOperationError")<{
  readonly operation: "activate" | "compact";
  readonly cause: unknown;
}> {}

export interface PiChannelSession {
  readonly isCompacting: boolean;
  readonly isStreaming: boolean;
  readonly isRetrying: boolean;
  activate(
    input: string,
    replyToMessageId: string,
  ): Effect.Effect<void, ChannelSessionOperationError>;
  requestCompaction(customInstructions?: string): Effect.Effect<void, ChannelSessionOperationError>;
}

export interface ScopedPiChannelSession {
  readonly session: PiChannelSession;
  readonly close: Effect.Effect<void>;
}

export const createPiChannelSession = (
  options: PiChannelSessionOptions,
): Effect.Effect<
  ScopedPiChannelSession,
  ChannelSessionInitError,
  AppConfig | LoadedResources | PiContext
> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const session = yield* createPiChannelSessionInScope(options).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
    return {
      session,
      close: Scope.close(scope, Exit.void),
    };
  });

const createPiChannelSessionInScope = (options: PiChannelSessionOptions) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const resources = yield* LoadedResources;
    const piContext = yield* PiContext;
    const settingsManager = SettingsManager.inMemory({
      steeringMode: "all",
      followUpMode: "all",
    });
    const extensionFactories: ExtensionFactory[] = [
      createPromptComposerExtension({
        botProfile: resources.botProfile,
        discordContextTemplate: resources.discordContextTemplate,
        enableAgenticWorkspace: config.enableAgenticWorkspace,
        promptContext: options.promptContext,
      }),
    ];

    if (config.enableAgenticWorkspace) {
      const gondolin = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createGondolinExtension({
            channelId: options.channel.id,
            sessionCwd: WORKSPACE_CWD,
            sessionLabel: `bubblebuddy:${options.channel.id}`,
            workspaceDir: options.hostWorkspaceDir,
          }),
        ),
        (gondolin) =>
          Effect.tryPromise(() => gondolin.dispose()).pipe(
            Effect.ignore({ log: "Warn", message: "Failed to dispose Gondolin workspace" }),
          ),
      );
      extensionFactories.push(gondolin.extensionFactory);
    }

    const resourceLoader = createChannelWorkspaceResourceLoader({
      agentDir: piContext.agentDir,
      enableAgenticWorkspace: config.enableAgenticWorkspace,
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

    const output = yield* makeDiscordOutputPump({
      getChannelSettings: options.getChannelSettings,
      sink: options.sink,
    });

    const discordTools = createDiscordTools(
      {
        channel: options.channel,
        client: options.channel.client,
        guild: options.channel.guild,
      },
      output.runDiscordAction,
      {
        enableAgenticWorkspace: config.enableAgenticWorkspace,
        workspaceDir: options.hostWorkspaceDir,
      },
    );

    let mcpTools: ToolDefinition[] = [];
    if (Object.keys(config.mcpServers).length > 0) {
      mcpTools = yield* connectMcpServers(
        Object.entries(config.mcpServers).map(([name, cfg]) => ({ name, ...cfg })),
      ).pipe(
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

    const { session } = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          createAgentSession({
            agentDir: piContext.agentDir,
            authStorage: piContext.authStorage,
            customTools: allTools,
            cwd: WORKSPACE_CWD,
            model: piContext.model,
            modelRegistry: piContext.modelRegistry,
            resourceLoader,
            sessionManager: options.sessionManager,
            settingsManager,
            thinkingLevel: config.thinkingLevel,
          }),
        catch: (error) =>
          new ChannelSessionInitError({ message: "Failed to create agent session", cause: error }),
      }),
      ({ session }) => Effect.sync(() => session.dispose()),
    );

    if (!config.enableAgenticWorkspace) {
      session.setActiveToolsByName(allTools.map((tool) => tool.name));
    }

    const operationLock = yield* Semaphore.make(1);
    let pendingQueue: Array<{ text: string; replyToMessageId: string }> = [];

    const prepareForClose = () =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => session.abort()).pipe(
          Effect.timeout(SHUTDOWN_ABORT_TIMEOUT),
          Effect.ignore({ log: "Warn", message: "Session abort for shutdown failed" }),
        );
        session.abortCompaction();
        output.enqueueRunEnd();
        yield* Effect.yieldNow;
        yield* output.drain();
      });

    const handleSessionEvent = (event: AgentSessionEvent): void => {
      if (event.type !== "compaction_end") return;

      const messages = pendingQueue;
      pendingQueue = [];
      if (messages.length === 0) return;

      for (const { text, replyToMessageId } of messages) {
        output.setReplyToMessageId(replyToMessageId);
        void session.steer(text);
      }

      if (event.result === undefined && !event.willRetry) {
        session.agent.continue();
      }
    };

    const activate = (input: string, replyToMessageId: string) =>
      operationLock.withPermit(
        Effect.tryPromise({
          try: async () => {
            output.setReplyToMessageId(replyToMessageId);

            if (session.isStreaming) {
              await session.steer(input);
              return;
            }

            if (session.isCompacting) {
              pendingQueue.push({ text: input, replyToMessageId });
              return;
            }

            if (session.isRetrying) {
              await session.steer(input);
              return;
            }

            void session.prompt(input).catch((error) => {
              output.enqueueUnexpectedError(error);
            });
          },
          catch: (cause) => new ChannelSessionOperationError({ operation: "activate", cause }),
        }),
      );

    const requestCompaction = (customInstructions?: string) =>
      operationLock.withPermit(
        Effect.tryPromise({
          try: () => session.compact(customInstructions),
          catch: (cause) => new ChannelSessionOperationError({ operation: "compact", cause }),
        }).pipe(Effect.asVoid),
      );

    yield* Effect.forkScoped(output.run());
    yield* Effect.addFinalizer(() => output.shutdownQueues());

    const unsubscribe = session.subscribe((event) => output.handleSessionEvent(event));
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const unsubscribeInternal = session.subscribe(handleSessionEvent);
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeInternal));
    yield* Effect.addFinalizer(prepareForClose);

    return {
      activate,
      requestCompaction,
      get isCompacting() {
        return session.isCompacting;
      },
      get isStreaming() {
        return session.isStreaming;
      },
      get isRetrying() {
        return session.isRetrying;
      },
    };
  });
