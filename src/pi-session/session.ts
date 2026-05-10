import { basename } from "node:path";

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionFactory,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { GuildTextBasedChannel } from "discord.js";
import { Data, Effect, FiberHandle, Exit, Scope, Semaphore } from "effect";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createDiscordTools } from "../discord/tools.ts";
import { connectMcpServers } from "../mcp/adapter.ts";
import { AppConfig } from "../config.ts";
import type { PromptTemplateContext } from "../prompt/system-prompt.ts";
import { LoadedResources } from "../resources.ts";
import type { SessionKeepAliveFactory } from "../channels/keep-alive.ts";
import { createChannelWorkspaceResourceLoader } from "./workspace-resource-loader.ts";
import { createGondolinExtension } from "./gondolin-extension.ts";
import { makeDiscordOutputPump } from "./discord-output-pump.ts";
import { createPromptComposerExtension } from "./prompt-extension.ts";
import { PiContext } from "./context.ts";
import { SHUTDOWN_ABORT_TIMEOUT, WORKSPACE_CWD } from "../shared/constants.ts";

export interface PiChannelSessionOptions {
  readonly channel: GuildTextBasedChannel;
  readonly getShowThinking: () => boolean;
  readonly hostWorkspaceDir: string;
  readonly promptContext: PromptTemplateContext;
  readonly sessionManager: SessionManager;
  readonly makeKeepAlive: SessionKeepAliveFactory;
}

export class ChannelSessionInitError extends Data.TaggedError("ChannelSessionInitError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ChannelSessionOperationError extends Data.TaggedError("ChannelSessionOperationError")<{
  readonly operation: "abort" | "activate" | "compact";
  readonly cause: unknown;
}> {}

export interface PiChannelSessionModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

export interface PiChannelSession {
  readonly isCompacting: () => boolean;
  readonly isStreaming: () => boolean;
  readonly isRetrying: () => boolean;
  readonly getActiveSessionName: () => string | undefined;
  readonly getModelInfo: () => PiChannelSessionModelInfo | undefined;
  readonly getSessionStats: () => SessionStats;
  abort(): Effect.Effect<void, ChannelSessionOperationError>;
  activate(
    input: string,
    replyToMessageId: string,
  ): Effect.Effect<void, ChannelSessionOperationError, Scope.Scope>;
  requestCompaction(customInstructions?: string): Effect.Effect<void, ChannelSessionOperationError>;
}

export interface ScopedPiChannelSession extends PiChannelSession {
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
      ...session,
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
      channel: options.channel,
      config,
      getShowThinking: options.getShowThinking,
    });

    const discordTools = createDiscordTools(
      {
        channel: options.channel,
        client: options.channel.client,
        guild: options.channel.guild,
      },
      output.awaitToolDiscordAction,
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
    const activationFiber = yield* FiberHandle.make<void, never>();
    let pendingQueue: Array<{ text: string; replyToMessageId: string }> = [];

    const isActivating = () => FiberHandle.getUnsafe(activationFiber)._tag === "Some";

    const abort = () =>
      Effect.gen(function* () {
        pendingQueue = [];
        session.abortCompaction();
        yield* Effect.tryPromise({
          try: () => session.abort(),
          catch: (cause) => new ChannelSessionOperationError({ operation: "abort", cause }),
        });
      });

    const prepareForClose = () =>
      abort().pipe(
        Effect.timeout(SHUTDOWN_ABORT_TIMEOUT),
        Effect.ignore({ log: "Warn", message: "Session abort for shutdown failed" }),
      );

    const handleSessionEvent = (event: AgentSessionEvent): void => {
      if (event.type !== "compaction_end") return;

      const messages = pendingQueue;
      pendingQueue = [];
      if (messages.length === 0) return;

      for (const { text, replyToMessageId } of messages) {
        output.pushActivationMessageId(replyToMessageId);
        void session.steer(text);
      }

      if (event.result === undefined && !event.willRetry) {
        session.agent.continue();
      }
    };

    const activate = (input: string, replyToMessageId: string) =>
      operationLock.withPermit(
        Effect.gen(function* () {
          output.pushActivationMessageId(replyToMessageId);

          if (session.isStreaming || isActivating()) {
            yield* Effect.tryPromise({
              try: () => session.steer(input),
              catch: (cause) => new ChannelSessionOperationError({ operation: "activate", cause }),
            });
            return;
          }

          if (session.isCompacting) {
            pendingQueue.push({ text: input, replyToMessageId });
            return;
          }

          if (session.isRetrying) {
            yield* Effect.tryPromise({
              try: () => session.steer(input),
              catch: (cause) => new ChannelSessionOperationError({ operation: "activate", cause }),
            });
            return;
          }

          const keepAlive = yield* options.makeKeepAlive();
          yield* FiberHandle.run(
            activationFiber,
            Effect.tryPromise({
              try: () =>
                session.prompt(input).catch((error) => {
                  output.reportUnexpectedError(error);
                }),
              catch: (cause) => new ChannelSessionOperationError({ operation: "activate", cause }),
            }).pipe(
              Effect.ensuring(keepAlive.release),
              Effect.ignore({ log: "Warn", message: "Session activation failed" }),
            ),
          );
        }),
      );

    const requestCompaction = (customInstructions?: string) =>
      operationLock.withPermit(
        Effect.tryPromise({
          try: () => session.compact(customInstructions),
          catch: (cause) => new ChannelSessionOperationError({ operation: "compact", cause }),
        }).pipe(Effect.asVoid),
      );

    const unsubscribe = session.subscribe((event) => output.handleSessionEvent(event));
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const unsubscribeInternal = session.subscribe(handleSessionEvent);
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeInternal));
    yield* Effect.addFinalizer(prepareForClose);

    return {
      abort,
      activate,
      requestCompaction,
      isCompacting: () => session.isCompacting,
      isStreaming: () => session.isStreaming || isActivating(),
      isRetrying: () => session.isRetrying,
      getActiveSessionName: () => {
        const sessionFile = options.sessionManager.getSessionFile();
        return sessionFile === undefined ? undefined : basename(sessionFile);
      },
      getModelInfo: () => {
        const model = session.model;
        return model === undefined
          ? undefined
          : { id: model.id, name: model.name, provider: model.provider };
      },
      getSessionStats: () => session.getSessionStats(),
    };
  });
