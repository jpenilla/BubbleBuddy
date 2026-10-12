import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  Harness,
  type Registry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type GuildTextBasedChannel } from "discord.js";
import {
  Cause,
  Context,
  Crypto,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Layer,
  Path,
  Schema,
  Scope,
} from "effect";
import { type HttpClient } from "effect/http";
import { GuestPath, IncusClient } from "incus-api";

import { AppHome } from "../config/env.ts";
import { FileConfig, type McpServerConfigEntry } from "../config/file.ts";
import { type OutputPump } from "../discord/output-pump.ts";
import { DiscordToolContext } from "../discord/tool-context.ts";
import { makeDiscordTools } from "../discord/tools.ts";
import { tryDiscordJsPromise } from "../discord/utils.ts";
import { McpClientFactory } from "../mcp/client-factory.ts";
import { McpPiTools } from "../mcp/pi-tools.ts";
import { LoadedResources } from "../resources.ts";
import { type Schedules } from "../scheduling/schedules.ts";
import { SessionContainer } from "../session/session-container.ts";
import { WORKSPACE_CWD } from "../shared/constants.ts";
import { channelHostSessionsDir, createChannelMountedWorkspace } from "../shared/workspace.ts";
import { PiContext } from "./context.ts";
import { tryDurablePromise } from "./durable.ts";
import { createIncusTools } from "./incus-tools.ts";
import { type SessionEvent, watchSessionEvents } from "./session-events.ts";
import {
  importLegacySession,
  LEGACY_SESSION_FILE_EXTENSION,
  removeUnfinishedImport,
} from "./session-import.ts";
import { createPromptSections } from "./system-prompt.ts";
import { loadWorkspaceResources } from "./workspace-resources.ts";

const IncusClientLayer = IncusClient.layer({ endpoint: { type: "unix" } });

const SESSION_FILE_EXTENSION = ".sqlite";

export interface PiSession {
  readonly sessionName: string;
  readonly harness: Harness;
  readonly conversation: Conversation;
  /**
   * Keep the channel session open until the conversation's work, background work included, is done; use after each
   * request for progress.
   */
  readonly retainUntilIdle: Effect.Effect<void>;
}

export interface CreatePiSessionInput {
  readonly channel: GuildTextBasedChannel;
  readonly activeSession?: string;
  readonly pump: OutputPump.Interface;
  readonly handleSessionEvent: (event: SessionEvent) => Effect.Effect<void>;
  /** Keeps the channel session open. */
  readonly retainChannelSession: Effect.Effect<void, never, Scope.Scope>;
}

export class PiSessionInitError extends Schema.TaggedError<PiSessionInitError>()(
  "PiSessionInitError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type PiSessionServices =
  | Crypto.Crypto
  | Schedules.Service
  | FileConfig
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | LoadedResources
  | Path.Path
  | GuestPath.Service
  | PiContext
  | AppHome;

const initError = (message: string) =>
  Effect.mapError((cause: unknown) => new PiSessionInitError({ message, cause }));

interface SessionFile {
  readonly name: string;
  readonly path: string;
  /** pi-coding-agent session file to import into `path`. */
  readonly legacy?: string;
}

/** The file of the channel's session: a new one, the active one, or a new one to import the active legacy session into. */
const resolveSessionFile = Effect.fnUntraced(function* (
  sessionsDir: string,
  activeSession: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  if (activeSession === undefined) {
    const name = `${yield* crypto.randomUUIDv7.pipe(initError("Failed to name session"))}${SESSION_FILE_EXTENSION}`;
    return { name, path: path.join(sessionsDir, name) } satisfies SessionFile;
  }
  if (activeSession.endsWith(LEGACY_SESSION_FILE_EXTENSION)) {
    // A pi-coding-agent session is imported into a new file of the same name; the old file stays as a backup.
    const name = `${path.basename(activeSession, LEGACY_SESSION_FILE_EXTENSION)}${SESSION_FILE_EXTENSION}`;
    const file = path.join(sessionsDir, name);
    const legacy = path.join(sessionsDir, activeSession);
    yield* removeUnfinishedImport(file).pipe(
      initError("Failed to remove an unfinished session import"),
    );
    // pi-coding-agent writes a session file only once it has an answer, so a missing one has no history.
    if (!(yield* fs.exists(legacy).pipe(initError("Failed to check session file")))) {
      yield* Effect.logInfo("pi-coding-agent session was never written; starting it empty");
      return { name, path: file } satisfies SessionFile;
    }
    return { name, path: file, legacy } satisfies SessionFile;
  }
  const file = path.join(sessionsDir, activeSession);
  // Opening storage creates a missing file, which would silently start the session over.
  if (!(yield* fs.exists(file).pipe(initError("Failed to check session file")))) {
    return yield* new PiSessionInitError({ message: `Session file ${file} is missing` });
  }
  return { name: activeSession, path: file } satisfies SessionFile;
});

/**
 * Opens the session's harness, importing a legacy session first. Closing keeps unfinished work in storage; it continues
 * when the channel is next opened.
 */
const openHarness = Effect.fnUntraced(function* (input: {
  readonly channelId: string;
  readonly sessionFile: SessionFile;
  readonly registry: Registry;
}) {
  const piContext = yield* PiContext;
  const runFork = Effect.runForkWith(yield* Effect.context());

  // Closing the harness also closes its storage, which tolerates closing twice.
  const storage = yield* Effect.acquireRelease(
    tryDurablePromise(() => openNodeSqliteStorage(input.sessionFile.path)),
    (storage) =>
      tryDurablePromise((context) => storage.close(context)).pipe(
        Effect.ignore({ log: "Warn", message: "Failed to close session storage" }),
      ),
  ).pipe(initError("Failed to open session storage"));
  const harness = yield* Effect.acquireRelease(
    tryDurablePromise((context) =>
      Harness.open(
        storage,
        {
          models: piContext.modelRuntime,
          registry: input.registry,
          settings: { steeringMode: "all", followUpMode: "all" },
          onReport: (error) =>
            runFork(
              Effect.logWarning("pi-durable extension failure", error).pipe(
                Effect.annotateLogs({ channelId: input.channelId }),
              ),
            ),
        },
        context,
      ),
    ),
    (harness) =>
      tryDurablePromise(() => harness.close(BACKGROUND_CONTEXT)).pipe(
        Effect.ignore({ log: "Warn", message: "Failed to close pi-durable harness" }),
      ),
  ).pipe(initError("Failed to open session storage"));

  const legacySession = input.sessionFile.legacy;
  if (legacySession !== undefined) {
    yield* importLegacySession(harness, legacySession).pipe(
      initError("Failed to import pi-coding-agent session"),
    );
    yield* Effect.logInfo("Imported pi-coding-agent session").pipe(
      Effect.annotateLogs({
        channelId: input.channelId,
        legacySession,
        sessionFile: input.sessionFile.path,
      }),
    );
  }
  return harness;
});

export const createPiSession = (
  input: CreatePiSessionInput,
): Effect.Effect<PiSession, PiSessionInitError, PiSessionServices | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* FileConfig;
    const resources = yield* LoadedResources;
    const piContext = yield* PiContext;
    const appHome = yield* AppHome;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const guestPath = yield* GuestPath.Service;
    const sessionsDir = channelHostSessionsDir(path, appHome, input.channel.id);
    const workspace = createChannelMountedWorkspace(
      path,
      guestPath.path,
      appHome,
      input.channel.id,
      WORKSPACE_CWD,
    );

    yield* fs
      .makeDirectory(sessionsDir, { recursive: true })
      .pipe(initError("Failed to create session directory"));
    yield* fs
      .makeDirectory(workspace.root.host, { recursive: true })
      .pipe(initError("Failed to create workspace directory"));

    const sessionFile = yield* resolveSessionFile(sessionsDir, input.activeSession);

    const sessionContainer = yield* Effect.gen(function* () {
      const context = yield* Layer.build(
        SessionContainer.layer({
          channelId: input.channel.id,
          cwd: workspace.root.container,
          workspaceDir: workspace.root.host,
        }).pipe(Layer.provide(IncusClientLayer), Layer.provide(GuestPath.layer)),
      ).pipe(initError("Invalid container working directory"));

      return Context.get(context, SessionContainer.Service);
    });
    let botMember = input.channel.guild.members.me;
    if (botMember === null) {
      botMember = yield* tryDiscordJsPromise(() => input.channel.guild.members.fetchMe()).pipe(
        Effect.orElseSucceed(() => null),
      );
    }

    const workspaceResources = yield* Effect.try({
      try: () =>
        loadWorkspaceResources({
          agentDir: piContext.agentDir,
          enableAgenticWorkspace: config.enableAgenticWorkspace,
          workspace,
        }),
      catch: (error) =>
        new PiSessionInitError({
          message: "Failed to load channel workspace resources",
          cause: error,
        }),
    });

    const toolContextLayer = Layer.succeed(
      DiscordToolContext,
      DiscordToolContext.of({
        channel: input.channel,
        executeOrdered: input.pump.executeOrdered,
      }),
    );

    const discordTools = yield* makeDiscordTools({
      enableAgenticWorkspace: config.enableAgenticWorkspace,
    }).pipe(
      Effect.provide(toolContextLayer),
      Effect.provideService(SessionContainer.Service, sessionContainer),
    );

    const mcpTools = yield* Effect.forEach(
      Object.entries(config.mcpServers),
      ([name, server]) => loadMcpServerTools(name, server),
      { concurrency: 3 },
    ).pipe(Effect.map((tools) => tools.flat()));

    const incusTools = config.enableAgenticWorkspace
      ? yield* createIncusTools({
          model: piContext.model,
          thinkingLevel: config.thinkingLevel,
          sessionId: path.basename(sessionFile.name, SESSION_FILE_EXTENSION),
        }).pipe(Effect.provideService(SessionContainer.Service, sessionContainer))
      : [];

    const registry = createRegistry();
    const extension = defineExtension({
      name: "bubblebuddy",
      tools: [...incusTools, ...discordTools, ...mcpTools],
      sections: createPromptSections({
        botProfileTemplate: resources.botProfile,
        discordContextTemplate: resources.discordContextTemplate,
        enableAgenticWorkspace: config.enableAgenticWorkspace,
        promptContext: {
          botUsername: input.channel.client.user.username,
          botDisplayName: botMember?.displayName ?? input.channel.client.user.displayName,
          channelName: input.channel.name,
          channelStatusText:
            "topic" in input.channel ? input.channel.topic?.trim() || "none" : "none",
          guildName: input.channel.guild.name,
        },
        cwd: workspace.root.container,
        resources: workspaceResources,
      }),
    });
    yield* Effect.try({
      try: () => registry.install(extension),
      catch: (error) =>
        new PiSessionInitError({ message: "Failed to install extension", cause: error }),
    });

    const harness = yield* openHarness({ channelId: input.channel.id, sessionFile, registry });

    const root = yield* tryDurablePromise((context) => harness.root(context)).pipe(
      initError("Failed to open conversation"),
    );
    yield* tryDurablePromise((context) =>
      root.configure(
        {
          model: { provider: piContext.model.provider, modelId: piContext.model.id },
          thinkingLevel: config.thinkingLevel,
        },
        context,
      ),
    ).pipe(initError("Failed to configure conversation"));

    yield* watchSessionEvents(harness, root.id, input.handleSessionEvent).pipe(
      initError("Failed to watch session events"),
    );

    // A run starts its background compaction in the same commit as other run work, so once the conversation is idle,
    // every background task the run started is live.
    const waitForBackgroundWork = tryDurablePromise((context) => harness.inspect(context)).pipe(
      Effect.flatMap((inspection) =>
        Effect.forEach(
          inspection.tasks.filter(
            ({ record }) => record.conversationId === root.id && record.background,
          ),
          ({ record }) => tryDurablePromise((context) => harness.waitForTask(record.id, context)),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );

    const retention = yield* FiberSet.make<void, never>();
    const retainUntilIdle = Effect.gen(function* () {
      // The work outlives the request for it, so it gets its own trace and a link back to the span that triggered it.
      // Each request waits on its own: one started earlier may be ending as this request's work is admitted.
      const triggerSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
      yield* FiberSet.run(
        retention,
        Effect.scoped(
          input.retainChannelSession.pipe(
            Effect.andThen(tryDurablePromise((context) => root.waitForIdle(context))),
            Effect.andThen(waitForBackgroundWork),
            Effect.onError((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.logDebug("Waiting for idle interrupted", cause)
                : Effect.logError("Waiting for idle failed", cause),
            ),
            Effect.withSpan("PiSession.retainUntilIdle", {
              root: true,
              attributes: {
                channelId: input.channel.id,
                modelId: piContext.model.id,
                modelProvider: piContext.model.provider,
              },
            }),
            Effect.linkSpans(triggerSpan, { relationship: "triggered_by" }),
            Effect.ignoreCause(),
          ),
        ),
      );
    });

    return {
      sessionName: sessionFile.name,
      harness,
      conversation: root,
      retainUntilIdle,
    } satisfies PiSession;
  });

const loadMcpServerTools = Effect.fnUntraced(
  function* (name: string, server: McpServerConfigEntry) {
    const serverScope = yield* Scope.fork(yield* Scope.Scope);

    return yield* Effect.gen(function* () {
      const client = yield* McpClientFactory.createClient(name, server);
      return yield* McpPiTools.createPiTools(client, name);
    }).pipe(
      Scope.provide(serverScope),
      Effect.timeout("10 seconds"),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Scope.close(serverScope, exit) : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("MCP tool loading failed; skipping server", cause).pipe(
          Effect.annotateLogs({ mcpServerName: name }),
          Effect.as([]),
        ),
      ),
    );
  },
  Effect.withSpan("PiSession.loadMcpServerTools", (name) => ({
    attributes: { mcpServerName: name },
  })),
);
