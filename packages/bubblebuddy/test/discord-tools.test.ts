import { it } from "@effect/vitest";
import { describe, expect, test } from "vitest";
import { open } from "node:fs/promises";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Message } from "discord.js";
import { Effect, FileSystem, Path } from "effect";

import { createDiscordTools } from "../src/discord/tools.ts";

const mockCtx = {} as unknown as ExtensionContext;

const UPLOAD_FILE_TOOL = "discord_upload_file";
const FETCH_MESSAGE_TOOL = "discord_fetch_message";
const REACT_TOOL = "discord_react";

type DiscordTool = ReturnType<typeof createDiscordTools>[number];

type UploadToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

const passthroughDiscordAction = <T>(
  operation: Effect.Effect<T, unknown>,
): Effect.Effect<T, unknown> => operation;

const makeOriginMessage = (
  premiumTier: number,
  send: (payload?: unknown) => Promise<unknown> = async () => undefined,
): Message<true> =>
  ({
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
    },
    guild: { premiumTier },
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
});

type FetchToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

const findFetchTool = (tools: readonly DiscordTool[]): DiscordTool => {
  const tool = tools.find((candidate) => candidate.name === FETCH_MESSAGE_TOOL);
  if (tool === undefined) {
    throw new Error("fetch tool missing");
  }
  return tool;
};

const makeFetchTool = (originMessage: Message<true>): DiscordTool =>
  findFetchTool(
    createDiscordTools(originMessage, passthroughDiscordAction, {
      enableAgenticWorkspace: false,
      workspaceDir: "/tmp",
    }),
  );

const executeFetchTool = async (
  tool: DiscordTool,
  params: { messageId: string },
): Promise<FetchToolResult> => {
  return (await tool.execute(
    "tool-call",
    params,
    undefined,
    undefined,
    mockCtx,
  )) as FetchToolResult;
};

const findUploadTool = (tools: readonly DiscordTool[]): DiscordTool => {
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
): DiscordTool =>
  findUploadTool(
    createDiscordTools(originMessage, runDiscordAction, {
      enableAgenticWorkspace: true,
      workspaceDir,
    }),
  );

const executeUploadTool = async (
  tool: DiscordTool,
  params: { path: string; caption?: string; fileName?: string },
): Promise<UploadToolResult> => {
  try {
    return (await tool.execute(
      "tool-call",
      params,
      undefined,
      undefined,
      mockCtx,
    )) as UploadToolResult;
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

const makeWorkspace = Effect.fn("discord-tools.test.makeWorkspace")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "bubblebuddy-upload-" });
});

it.layer(NodeServices.layer)("discord upload tool", (it) => {
  it.effect("is only registered when agentic workspace is enabled", () =>
    Effect.sync(() => {
      const originMessage = makeOriginMessage(0);

      const enabled = createDiscordTools(originMessage, passthroughDiscordAction, {
        enableAgenticWorkspace: true,
        workspaceDir: "/tmp",
      });
      const disabled = createDiscordTools(originMessage, passthroughDiscordAction, {
        enableAgenticWorkspace: false,
        workspaceDir: "/tmp",
      });

      expect(enabled.some((tool) => tool.name === UPLOAD_FILE_TOOL)).toBe(true);
      expect(disabled.some((tool) => tool.name === UPLOAD_FILE_TOOL)).toBe(false);
    }),
  );

  it.effect("rejects paths outside workspace", () =>
    Effect.gen(function* () {
      const workspaceDir = yield* makeWorkspace();
      const result = yield* Effect.promise(() =>
        executeUploadTool(makeUploadTool(makeOriginMessage(0), workspaceDir), {
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

      const originMessage = makeOriginMessage(0, async (payload) => {
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
      premiumTier: 0,
      size: 10 * 1024 * 1024 + 1,
      expectedLimit: 10 * 1024 * 1024,
    },
    {
      name: "rejects files larger than tier 2 limit",
      premiumTier: 2,
      size: 50 * 1000 * 1000 + 1,
      expectedLimit: 50 * 1000 * 1000,
    },
    {
      name: "rejects files larger than tier 3 limit",
      premiumTier: 3,
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
            makeOriginMessage(2, async () => {
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
  test("throws when channel does not support fetching", async () => {
    const originMessage = makeOriginMessage(0);

    await expect(
      executeFetchTool(makeFetchTool(originMessage), { messageId: "123" }),
    ).rejects.toThrow("This Discord channel does not support fetching messages.");
  });

  test("throws when message is not found", async () => {
    const notFoundError = new Error("DiscordAPIError[10008]: Unknown Message");

    const originMessage = makeOriginMessageWithFetch(async () => {
      throw notFoundError;
    });

    await expect(executeFetchTool(makeFetchTool(originMessage), { messageId: "123" })).rejects.toBe(
      notFoundError,
    );
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
  ) =>
    createDiscordTools(makeOriginMessageForReact(fetch), passthroughDiscordAction, {
      enableAgenticWorkspace: false,
      workspaceDir: "/tmp",
    }).find((t) => t.name === REACT_TOOL)!;

  test("adds multiple reactions", async () => {
    const reacted: string[] = [];
    const msg = {
      id: "m1",
      react: async (e: string) => {
        reacted.push(e);
      },
    };
    const tool = makeReactTool(async () => msg);

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
    const tool = makeReactTool(async () => msg);

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
