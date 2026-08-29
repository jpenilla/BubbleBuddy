import { basename } from "node:path";

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionFactory,
  type SessionStats,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { GuildTextBasedChannel } from "discord.js";
import { Effect, FiberHandle, FileSystem, Layer, Path, Schema, Scope, Semaphore } from "effect";
import { HttpClient } from "effect/unstable/http";

import { discordCoreTools, discordWorkspaceTools } from "../discord/tools.ts";
import { ChannelWorkspace, DiscordToolContext } from "../discord/tool-context.ts";
import { connectMcpServers } from "../mcp/adapter.ts";
import { AppHome } from "../config/env.ts";
import { FileConfig } from "../config/file.ts";
import { LoadedResources } from "../resources.ts";
import { createChannelWorkspaceResourceLoader } from "./workspace-resource-loader.ts";
import { createIncusExtension } from "./incus-extension.ts";
import type { DiscordOutputPump } from "../discord/session-output-pump.ts";
import { createPromptComposerExtension } from "./prompt-extension.ts";
import { PiContext } from "./context.ts";
import { SHUTDOWN_ABORT_TIMEOUT, WORKSPACE_CWD } from "../shared/constants.ts";
import { channelHostSessionsDir, createChannelMountedWorkspace } from "../shared/workspace.ts";
import type { PromptTemplateContext } from "./system-prompt.ts";

export interface PiSessionModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

export interface PiSessionHandle {
  readonly isCompacting: () => boolean;
  readonly isStreaming: () => boolean;
  readonly isRetrying: () => boolean;
  readonly getActiveSessionName: () => string | undefined;
  readonly getModelInfo: () => PiSessionModelInfo | undefined;
  readonly getSessionStats: () => SessionStats;
  readonly abort: Effect.Effect<void, PiSessionOperationError>;
  readonly activate: (
    input: ActivatePiSessionInput,
  ) => Effect.Effect<void, PiSessionOperationError>;
  readonly requestCompaction: (
    customInstructions?: string,
  ) => Effect.Effect<void, PiSessionOperationError>;
}

export interface ActivatePiSessionInput {
  readonly prompt: string;
  readonly replyToMessageId: string;
  readonly retainChannelSession: Effect.Effect<void, never, Scope.Scope>;
}

export interface CreatePiSessionInput {
  readonly channel: GuildTextBasedChannel;
  readonly promptContext: PromptTemplateContext;
  readonly activeSession?: string;
  readonly output: DiscordOutputPump;
}

export type { SessionStats };

export class PiSessionInitError extends Schema.TaggedError<PiSessionInitError>()(
  "PiSessionInitError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class PiSessionOperationError extends Schema.TaggedError<PiSessionOperationError>()(
  "PiSessionOperationError",
  {
    operation: Schema.Literals(["abort", "activate", "compact"]),
    cause: Schema.Defect(),
  },
) {}

export type PiSessionServices =
  | FileConfig
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | LoadedResources
  | Path.Path
  | PiContext
  | AppHome;

export const createPiSession = (
  input: CreatePiSessionInput,
): Effect.Effect<PiSessionHandle, PiSessionInitError, PiSessionServices | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* FileConfig;
    const resources = yield* LoadedResources;
    const piContext = yield* PiContext;
    const appHome = yield* AppHome;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sessionsDir = channelHostSessionsDir(path, appHome, input.channel.id);
    const workspace = createChannelMountedWorkspace(path, appHome, input.channel.id, WORKSPACE_CWD);

    yield* fs
      .makeDirectory(sessionsDir, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PiSessionInitError({ message: "Failed to create session directory", cause }),
        ),
      );
    yield* fs
      .makeDirectory(workspace.root.host, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PiSessionInitError({ message: "Failed to create workspace directory", cause }),
        ),
      );

    const activeSession = input.activeSession;
    const sessionManager =
      activeSession === undefined
        ? SessionManager.create(WORKSPACE_CWD, sessionsDir)
        : yield* Effect.try({
            try: () =>
              SessionManager.open(
                path.join(sessionsDir, activeSession),
                sessionsDir,
                WORKSPACE_CWD,
              ),
            catch: (cause) =>
              new PiSessionInitError({ message: "Failed to resume persisted session", cause }),
          }).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                `Failed to resume session for channel ${input.channel.id}. Starting a new session.`,
                error,
              ),
            ),
            Effect.orElseSucceed(() => SessionManager.create(WORKSPACE_CWD, sessionsDir)),
          );
    const settingsManager = SettingsManager.inMemory({
      steeringMode: "all",
      followUpMode: "all",
    });
    const extensionFactories: ExtensionFactory[] = [
      createPromptComposerExtension({
        botProfile: resources.botProfile,
        discordContextTemplate: resources.discordContextTemplate,
        enableAgenticWorkspace: config.enableAgenticWorkspace,
        promptContext: input.promptContext,
      }),
    ];

    if (config.enableAgenticWorkspace) {
      extensionFactories.push(
        yield* createIncusExtension({
          channelId: input.channel.id,
          sessionCwd: workspace.root.container,
          workspaceDir: workspace.root.host,
        }),
      );
    }

    const resourceLoader = createChannelWorkspaceResourceLoader({
      agentDir: piContext.agentDir,
      enableAgenticWorkspace: config.enableAgenticWorkspace,
      extensionFactories,
      settingsManager,
      workspace,
    });
    yield* Effect.tryPromise({
      try: () => resourceLoader.reload(),
      catch: (error) =>
        new PiSessionInitError({
          message: "Failed to reload channel workspace resources",
          cause: error,
        }),
    });

    const output = input.output;
    const toolContextLayer = Layer.mergeAll(
      Layer.succeed(
        DiscordToolContext,
        DiscordToolContext.of({
          channel: input.channel,
          awaitAction: output.awaitToolDiscordAction,
        }),
      ),
      Layer.succeed(ChannelWorkspace, ChannelWorkspace.of(workspace)),
    );

    const discordTools = yield* Effect.gen(function* () {
      const core = yield* discordCoreTools();
      if (!config.enableAgenticWorkspace) return core;
      return [...core, ...(yield* discordWorkspaceTools())];
    }).pipe(Effect.provide(toolContextLayer));

    let mcpTools: ToolDefinition[] = [];
    if (Object.keys(config.mcpServers).length > 0) {
      mcpTools = yield* connectMcpServers(
        Object.entries(config.mcpServers).map(([name, cfg]) => ({ name, ...cfg })),
      ).pipe(
        Effect.mapError(
          (error) =>
            new PiSessionInitError({
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
            customTools: allTools,
            cwd: workspace.root.container,
            model: piContext.model,
            modelRuntime: piContext.modelRuntime,
            resourceLoader,
            sessionManager,
            settingsManager,
            thinkingLevel: config.thinkingLevel,
          }),
        catch: (error) =>
          new PiSessionInitError({ message: "Failed to create agent session", cause: error }),
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

    const abort = Effect.gen(function* () {
      pendingQueue = [];
      yield* Effect.try({
        try: () => session.abortCompaction(),
        catch: (cause) => new PiSessionOperationError({ operation: "abort", cause }),
      });
      yield* Effect.tryPromise({
        try: () => session.abort(),
        catch: (cause) => new PiSessionOperationError({ operation: "abort", cause }),
      });
    });

    const prepareForClose = () =>
      abort.pipe(
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

    const activate = (activation: ActivatePiSessionInput) =>
      operationLock.withPermit(
        Effect.gen(function* () {
          output.pushActivationMessageId(activation.replyToMessageId);

          if (session.isStreaming || isActivating()) {
            yield* Effect.tryPromise({
              try: () => session.steer(activation.prompt),
              catch: (cause) => new PiSessionOperationError({ operation: "activate", cause }),
            });
            return;
          }

          if (session.isCompacting) {
            pendingQueue.push({
              text: activation.prompt,
              replyToMessageId: activation.replyToMessageId,
            });
            return;
          }

          if (session.isRetrying) {
            yield* Effect.tryPromise({
              try: () => session.steer(activation.prompt),
              catch: (cause) => new PiSessionOperationError({ operation: "activate", cause }),
            });
            return;
          }

          yield* FiberHandle.run(
            activationFiber,
            Effect.scoped(
              activation.retainChannelSession.pipe(
                Effect.andThen(
                  Effect.tryPromise({
                    try: () =>
                      session.prompt(activation.prompt).catch((error) => {
                        output.reportUnexpectedError(error);
                      }),
                    catch: (cause) => new PiSessionOperationError({ operation: "activate", cause }),
                  }),
                ),
                Effect.ignoreCause({ log: "Warn", message: "Session activation failed" }),
              ),
            ),
          );
        }),
      );

    const requestCompaction = (customInstructions?: string) =>
      operationLock.withPermit(
        Effect.tryPromise({
          try: () => session.compact(customInstructions),
          catch: (cause) => new PiSessionOperationError({ operation: "compact", cause }),
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
        const sessionFile = sessionManager.getSessionFile();
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
