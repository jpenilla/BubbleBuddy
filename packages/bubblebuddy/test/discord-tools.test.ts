import { it } from "@effect/vitest";
import { describe, expect, test } from "vitest";
import { open } from "node:fs/promises";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Collection, GuildPremiumTier } from "discord.js";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { discordCoreTools, discordWorkspaceTools } from "../src/discord/tools.ts";
import { ChannelWorkspace, DiscordToolContext } from "../src/discord/tool-context.ts";
import { makeMountedWorkspace } from "../src/shared/workspace.ts";
import { WORKSPACE_CWD } from "../src/shared/constants.ts";
import type { AwaitToolDiscordAction } from "../src/discord/session-output-pump.ts";

const mockCtx = {} as unknown as ExtensionContext;

const UPLOAD_FILE_TOOL = "discord_upload_file";
const FETCH_MESSAGE_TOOL = "discord_fetch_message";
const REACT_TOOL = "discord_react";

type UploadToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

const passthroughDiscordAction: AwaitToolDiscordAction = <A, E>(
  operation: Effect.Effect<A, E>,
): Effect.Effect<A, E> => operation;

const buildTools = async (options: {
  readonly message: Message<true>;
  readonly workspaceDir?: string;
  readonly awaitAction?: AwaitToolDiscordAction;
}): Promise<readonly ToolDefinition[]> => {
  const channel = options.message.channel as unknown as GuildTextBasedChannel;
  return await Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const core = yield* discordCoreTools();
      if (options.workspaceDir === undefined) return core;
      const workspaceTools = yield* discordWorkspaceTools().pipe(
        Effect.provideService(
          ChannelWorkspace,
          ChannelWorkspace.of(makeMountedWorkspace(path, options.workspaceDir, WORKSPACE_CWD)),
        ),
      );
      return [...core, ...workspaceTools];
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          FetchHttpClient.layer,
          Layer.succeed(
            DiscordToolContext,
            DiscordToolContext.of({
              channel,
              awaitAction: options.awaitAction ?? passthroughDiscordAction,
            }),
          ),
        ),
      ),
    ),
  );
};

const makeOriginMessage = (
  premiumTier: GuildPremiumTier,
  send: (payload?: unknown) => Promise<unknown> = async () => undefined,
): Message<true> =>
  ({
    attachments: new Collection(),
    channel: {
      send,
      id: "channel-id",
      client: {
        options: {},
        user: { id: "bot-id" },
        rest: {
          post: async (_route: string, payload: { body?: unknown; files?: unknown }) =>
            send({ ...(payload.body as object), files: payload.files }),
        },
      },
      guild: { premiumTier, id: "guild-id", emojis: { cache: new Map() } },
    },
    guild: { premiumTier, id: "guild-id", emojis: { cache: new Map() } },
  }) as unknown as Message<true>;

const makeOriginMessageWithFetch = (fetch: (id: string) => Promise<unknown>): Message<true> =>
  ({
    channel: {
      messages: { fetch },
    },
  }) as unknown as Message<true>;

const makeFetchedMessage = (options: {
  id: string;
  authorUsername: string;
  authorId: string;
  content: string;
  channelId: string;
  mentions?: Map<string, { id: string; username: string }>;
  reference?: { messageId: string; channelId: string } | null;
}): unknown => ({
  id: options.id,
  author: { username: options.authorUsername, id: options.authorId },
  content: options.content,
  mentions: { users: options.mentions ?? new Map() },
  reference: options.reference ?? null,
  channelId: options.channelId,
  attachments: new Collection(),
});

type FetchToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

const findFetchTool = (tools: readonly ToolDefinition[]): ToolDefinition => {
  const tool = tools.find((candidate) => candidate.name === FETCH_MESSAGE_TOOL);
  if (tool === undefined) {
    throw new Error("fetch tool missing");
  }
  return tool;
};

const makeFetchTool = (originMessage: Message<true>): Promise<ToolDefinition> =>
  buildTools({ message: originMessage }).then(findFetchTool);

const executeFetchTool = async (
  tool: ToolDefinition | Promise<ToolDefinition>,
  params: { messageId: string },
): Promise<FetchToolResult> => {
  return (await (
    await tool
  ).execute("tool-call", params, undefined, undefined, mockCtx)) as FetchToolResult;
};

const findUploadTool = (tools: readonly ToolDefinition[]): ToolDefinition => {
  const tool = tools.find((candidate) => candidate.name === UPLOAD_FILE_TOOL);
  if (tool === undefined) {
    throw new Error("upload tool missing");
  }
  return tool;
};

const makeUploadTool = (
  originMessage: Message<true>,
  workspaceDir: string,
  runDiscordAction = passthroughDiscordAction,
): Promise<ToolDefinition> =>
  buildTools({
    message: originMessage,
    workspaceDir,
    awaitAction: runDiscordAction,
  }).then(findUploadTool);

const executeUploadTool = async (
  tool: ToolDefinition | Promise<ToolDefinition>,
  params: { path: string; caption?: string; fileName?: string },
): Promise<UploadToolResult> => {
  try {
    return (await (
      await tool
    ).execute("tool-call", params, undefined, undefined, mockCtx)) as UploadToolResult;
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      details: {},
      isError: true,
    };
  }
};

const createSparseFile = async (path: string, size: number): Promise<void> => {
  const handle = await open(path, "w");
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
};

const makeWorkspace = Effect.fn("makeWorkspace")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "bubblebuddy-upload-" });
});

it.layer(NodeServices.layer)("discord upload tool", (it) => {
  it.effect("is only registered when agentic workspace is enabled", () =>
    Effect.promise(async () => {
      const originMessage = makeOriginMessage(GuildPremiumTier.None);
      const enabled = await buildTools({ message: originMessage, workspaceDir: "/tmp" });
      const disabled = await buildTools({ message: originMessage });

      expect(enabled.some((tool) => tool.name === UPLOAD_FILE_TOOL)).toBe(true);
      expect(disabled.some((tool) => tool.name === UPLOAD_FILE_TOOL)).toBe(false);
    }),
  );

  it.effect("rejects paths outside workspace", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* makeWorkspace();
      const result = yield* Effect.promise(() =>
        executeUploadTool(makeUploadTool(makeOriginMessage(GuildPremiumTier.None), workspaceDir), {
          path: "/etc/passwd",
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain(
        "Absolute paths outside /workspace are not allowed.",
      );
    }),
  );

  it.effect("uploads a file from workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let runDiscordActionCalls = 0;
      let sentName: string | null | undefined;
      let sentAttachment: unknown;

      const workspaceDir = yield* makeWorkspace();
      const filePath = path.join(workspaceDir, "report.txt");
      yield* fs.writeFileString(filePath, "hello world");

      const originMessage = makeOriginMessage(GuildPremiumTier.None, async (payload) => {
        const message = payload as { files: Array<{ data: Buffer; name: string }> };
        sentName = message.files[0]?.name;
        sentAttachment = message.files[0]?.data;
        return undefined;
      });

      const tool = makeUploadTool(originMessage, workspaceDir, (operation) =>
        Effect.gen(function* () {
          runDiscordActionCalls++;
          return yield* operation;
        }),
      );

      const result = yield* Effect.promise(() =>
        executeUploadTool(tool, { path: "/workspace/report.txt" }),
      );

      expect(runDiscordActionCalls).toBe(1);
      expect(sentName).toBe("report.txt");
      expect(sentAttachment).toEqual(Buffer.from("hello world"));
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain(
        `Uploaded file report.txt from /workspace/report.txt (${Buffer.byteLength("hello world")} bytes).`,
      );
    }),
  );

  for (const testCase of [
    {
      name: "rejects files larger than default tier limit",
      premiumTier: GuildPremiumTier.None,
      size: 10 * 1024 * 1024 + 1,
      expectedLimit: 10 * 1024 * 1024,
    },
    {
      name: "rejects files larger than tier 2 limit",
      premiumTier: GuildPremiumTier.Tier2,
      size: 50 * 1000 * 1000 + 1,
      expectedLimit: 50 * 1000 * 1000,
    },
    {
      name: "rejects files larger than tier 3 limit",
      premiumTier: GuildPremiumTier.Tier3,
      size: 100 * 1000 * 1000 + 1,
      expectedLimit: 100 * 1000 * 1000,
    },
    {
      name: "rejects files larger than a future higher-tier limit using the highest known cap",
      premiumTier: (GuildPremiumTier.Tier3 + 1) as GuildPremiumTier,
      size: 100 * 1000 * 1000 + 1,
      expectedLimit: 100 * 1000 * 1000,
    },
  ]) {
    it.effect(testCase.name, () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const workspaceDir = yield* makeWorkspace();
        const filePath = path.join(workspaceDir, "big.bin");
        yield* Effect.promise(() => createSparseFile(filePath, testCase.size));

        const result = yield* Effect.promise(() =>
          executeUploadTool(makeUploadTool(makeOriginMessage(testCase.premiumTier), workspaceDir), {
            path: "/workspace/big.bin",
          }),
        );

        expect(result.isError).toBe(true);
        expect(result.content[0]?.type).toBe("text");
        expect(result.content[0]?.text).toContain(
          `exceeds this server's upload limit of ${testCase.expectedLimit} bytes`,
        );
      }),
    );
  }

  it.effect("allows files within tier 2 limit", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      let sent = false;
      const workspaceDir = yield* makeWorkspace();
      const filePath = path.join(workspaceDir, "big.bin");
      yield* Effect.promise(() => createSparseFile(filePath, 49 * 1000 * 1000));

      const result = yield* Effect.promise(() =>
        executeUploadTool(
          makeUploadTool(
            makeOriginMessage(GuildPremiumTier.Tier2, async () => {
              sent = true;
              return undefined;
            }),
            workspaceDir,
          ),
          { path: "/workspace/big.bin" },
        ),
      );

      expect(result.isError).toBeUndefined();
      expect(sent).toBe(true);
    }),
  );
});

describe("discord fetch message tool", () => {
  test("returns a generic discord error when message lookup fails", async () => {
    const notFoundError = new Error("DiscordAPIError[10008]: Unknown Message");

    const originMessage = makeOriginMessageWithFetch(async () => {
      throw notFoundError;
    });

    await expect(
      executeFetchTool(makeFetchTool(originMessage), { messageId: "123" }),
    ).rejects.toThrow("Discord operation failed.");
  });

  test.each([
    {
      name: "returns formatted message content",
      reference: undefined,
      expected: "[msg 456 user=alice mention=<@789>] Hello world",
    },
    {
      name: "includes reply reference when present",
      reference: { messageId: "111", channelId: "channel-1" },
      expected: "[msg 456 user=alice mention=<@789> reply_to=111] Hello world",
    },
  ])("$name", async ({ reference, expected }) => {
    const tool = makeFetchTool(
      makeOriginMessageWithFetch(async () =>
        makeFetchedMessage({
          id: "456",
          authorUsername: "alice",
          authorId: "789",
          content: "Hello world",
          channelId: "channel-1",
          reference,
        }),
      ),
    );
    const result = await executeFetchTool(tool, { messageId: "456" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(expected);
  });
});

describe("discord react tool", () => {
  const makeOriginMessageForReact = (
    fetch: (id: string) => Promise<{ id: string; react: (emoji: string) => Promise<void> }>,
  ): Message<true> =>
    ({
      channel: {
        messages: { fetch },
        permissionsFor: () => null,
        client: {
          user: { id: "bot1" },
          emojis: { cache: new Map() },
        },
        guild: {
          id: "g1",
          emojis: { cache: new Map() },
        },
      },
      guild: {
        id: "g1",
        emojis: { cache: new Map() },
      },
      client: {
        user: { id: "bot1" },
        emojis: { cache: new Map() },
      },
    }) as unknown as Message<true>;

  const makeReactTool = (
    fetch: (id: string) => Promise<{ id: string; react: (emoji: string) => Promise<void> }>,
  ): Promise<ToolDefinition> =>
    buildTools({ message: makeOriginMessageForReact(fetch) }).then((tools) => {
      const tool = tools.find((candidate) => candidate.name === REACT_TOOL);
      if (tool === undefined) throw new Error("react tool missing");
      return tool;
    });

  test("adds multiple reactions", async () => {
    const reacted: string[] = [];
    const msg = {
      id: "m1",
      react: async (e: string) => {
        reacted.push(e);
      },
    };
    const tool = await makeReactTool(async () => msg);

    const result = (await tool.execute(
      "tool-call",
      { messageId: "m1", emojis: ["👍", "🎉"] },
      undefined,
      undefined,
      mockCtx,
    )) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content[0]?.text).toBe("Reactions added.");
    expect(reacted).toEqual(["👍", "🎉"]);
  });

  test("applies valid reactions and reports combined failures", async () => {
    const reacted: string[] = [];
    const msg = {
      id: "m1",
      react: async (e: string) => {
        if (e === "🎉") throw new Error("blocked");
        reacted.push(e);
      },
    };
    const tool = await makeReactTool(async () => msg);

    let error: unknown;
    try {
      await tool.execute(
        "tool-call",
        { messageId: "m1", emojis: ["👍", ":bad:", "🎉"] },
        undefined,
        undefined,
        mockCtx,
      );
    } catch (e) {
      error = e;
    }

    expect(reacted).toEqual(["👍"]);
    expect(String(error)).toContain("Failed to add reactions");
    expect(String(error)).toContain(":bad:");
    expect(String(error)).toContain("blocked");
  });
});
