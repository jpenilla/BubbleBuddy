import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message } from "discord.js";

import { createDiscordTools } from "../src/discord/tools.ts";

const UPLOAD_FILE_TOOL = "discord_upload_file";

type DiscordTool = ReturnType<typeof createDiscordTools>[number];

type UploadToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

const passthroughDiscordAction = async <T>(operation: () => Promise<T>): Promise<T> =>
  await operation();

const makeOriginMessage = (
  premiumTier: number,
  send: (payload?: unknown) => Promise<unknown> = async () => undefined,
): Message<true> =>
  ({
    channel: { send },
    guild: { premiumTier },
  }) as unknown as Message<true>;

const findUploadTool = (tools: readonly DiscordTool[]): DiscordTool => {
  const tool = tools.find((candidate) => candidate.name === UPLOAD_FILE_TOOL);
  if (tool === undefined) {
    throw new Error("upload tool missing");
  }
  return tool;
};

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
      undefined,
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

const tempWorkspaces: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "bubblebuddy-upload-"));
  tempWorkspaces.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempWorkspaces.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("discord upload tool", () => {
  test("is only registered when agentic workspace is enabled", () => {
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
  });

  test("rejects paths outside workspace", async () => {
    const originMessage = makeOriginMessage(0);
    const workspaceDir = await makeWorkspace();

    const tool = findUploadTool(
      createDiscordTools(originMessage, passthroughDiscordAction, {
        enableAgenticWorkspace: true,
        workspaceDir,
      }),
    );

    const result = await executeUploadTool(tool, { path: "/etc/passwd" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Absolute paths outside /workspace are not allowed.");
  });

  test("uploads a file from workspace", async () => {
    let runDiscordActionCalls = 0;
    let sentName: string | null | undefined;
    let sentAttachment: unknown;

    const workspaceDir = await makeWorkspace();
    const filePath = join(workspaceDir, "report.txt");
    await writeFile(filePath, "hello world");

    const originMessage = makeOriginMessage(0, async (payload) => {
      const message = payload as { files: Array<{ attachment: string; name: string }> };
      sentName = message.files[0]?.name;
      sentAttachment = message.files[0]?.attachment;
      return undefined;
    });

    const tool = findUploadTool(
      createDiscordTools(
        originMessage,
        async (operation) => {
          runDiscordActionCalls++;
          return await operation();
        },
        {
          enableAgenticWorkspace: true,
          workspaceDir,
        },
      ),
    );

    const result = await executeUploadTool(tool, { path: "/workspace/report.txt" });

    expect(runDiscordActionCalls).toBe(1);
    expect(sentName).toBe("report.txt");
    expect(sentAttachment).toBe(filePath);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain(
      `Uploaded file report.txt from /workspace/report.txt (${Buffer.byteLength("hello world")} bytes).`,
    );
  });

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
    test(testCase.name, async () => {
      const workspaceDir = await makeWorkspace();
      const filePath = join(workspaceDir, "big.bin");
      await createSparseFile(filePath, testCase.size);

      const tool = findUploadTool(
        createDiscordTools(makeOriginMessage(testCase.premiumTier), passthroughDiscordAction, {
          enableAgenticWorkspace: true,
          workspaceDir,
        }),
      );

      const result = await executeUploadTool(tool, { path: "/workspace/big.bin" });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain(
        `exceeds this server's upload limit of ${testCase.expectedLimit} bytes`,
      );
    });
  }

  test("allows files within tier 2 limit", async () => {
    let sent = false;
    const workspaceDir = await makeWorkspace();
    const filePath = join(workspaceDir, "big.bin");
    await createSparseFile(filePath, 49 * 1000 * 1000);

    const tool = findUploadTool(
      createDiscordTools(
        makeOriginMessage(2, async () => {
          sent = true;
          return undefined;
        }),
        passthroughDiscordAction,
        {
          enableAgenticWorkspace: true,
          workspaceDir,
        },
      ),
    );

    const result = await executeUploadTool(tool, { path: "/workspace/big.bin" });

    expect(result.isError).toBeUndefined();
    expect(sent).toBe(true);
  });
});
