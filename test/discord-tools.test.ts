import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type { Message } from "discord.js";

import { createDiscordTools } from "../src/discord/tools.ts";

const UPLOAD_FILE_TOOL = "discord_upload_file";

const executeUploadTool = async (tool: unknown, params: Record<string, unknown>) =>
  await (tool as { execute: (...args: any[]) => Promise<unknown> }).execute(
    "tool-call",
    params,
    undefined,
    undefined,
    undefined,
  );

describe("discord upload tool", () => {
  test("is only registered when agentic workspace is enabled", () => {
    const originMessage = {
      channel: {
        send: async () => undefined,
      },
    } as unknown as Message<true>;

    const enabled = createDiscordTools(originMessage, async (operation) => await operation(), {
      enableAgenticWorkspace: true,
      workspaceDir: "/tmp",
    });
    const disabled = createDiscordTools(originMessage, async (operation) => await operation(), {
      enableAgenticWorkspace: false,
      workspaceDir: "/tmp",
    });

    expect(enabled.some((tool) => tool.name === UPLOAD_FILE_TOOL)).toBe(true);
    expect(disabled.some((tool) => tool.name === UPLOAD_FILE_TOOL)).toBe(false);
  });

  test("forwards Discord upload rejection as tool error", async () => {
    let runDiscordActionCalls = 0;
    const workspaceDir = await mkdtemp(join(tmpdir(), "bubblebuddy-upload-"));
    const filePath = join(workspaceDir, "hello.txt");
    await writeFile(filePath, "hello");

    const originMessage = {
      channel: {
        send: async () => {
          throw new Error("Request entity too large");
        },
      },
    } as unknown as Message<true>;

    const tools = createDiscordTools(
      originMessage,
      async (operation) => {
        runDiscordActionCalls++;
        return await operation();
      },
      {
        enableAgenticWorkspace: true,
        workspaceDir,
      },
    );

    const tool = tools.find((candidate) => candidate.name === UPLOAD_FILE_TOOL);
    if (tool === undefined) {
      throw new Error("upload tool missing");
    }

    const result = (await executeUploadTool(tool, {
      fileName: "hello.txt",
      path: "/workspace/hello.txt",
    })) as any;

    expect(runDiscordActionCalls).toBe(2);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Discord rejected file upload hello.txt");
    expect(result.content[0]?.text).toContain("path attempt failed:");
    expect(result.content[0]?.text).toContain("buffer attempt failed:");
    expect(result.content[0]?.text).toContain("Request entity too large");
  });

  test("rejects paths outside workspace", async () => {
    let runDiscordActionCalls = 0;
    const workspaceDir = await mkdtemp(join(tmpdir(), "bubblebuddy-upload-"));

    const originMessage = {
      channel: {
        send: async () => undefined,
      },
    } as unknown as Message<true>;

    const tools = createDiscordTools(
      originMessage,
      async (operation) => {
        runDiscordActionCalls++;
        return await operation();
      },
      {
        enableAgenticWorkspace: true,
        workspaceDir,
      },
    );

    const tool = tools.find((candidate) => candidate.name === UPLOAD_FILE_TOOL);
    if (tool === undefined) {
      throw new Error("upload tool missing");
    }

    const result = (await executeUploadTool(tool, {
      path: "/etc/passwd",
    })) as any;

    expect(runDiscordActionCalls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Absolute paths outside /workspace are not allowed.");
  });

  test("uploads a file from workspace", async () => {
    let runDiscordActionCalls = 0;
    let sentName: string | null | undefined;
    let sentAttachment: unknown;
    const workspaceDir = await mkdtemp(join(tmpdir(), "bubblebuddy-upload-"));
    const filePath = join(workspaceDir, "report.txt");
    await writeFile(filePath, "hello world");

    const originMessage = {
      channel: {
        send: async (payload: { files: Array<{ attachment: string; name: string }> }) => {
          sentName = payload.files[0]?.name;
          sentAttachment = payload.files[0]?.attachment;
          return undefined;
        },
      },
    } as unknown as Message<true>;

    const tools = createDiscordTools(
      originMessage,
      async (operation) => {
        runDiscordActionCalls++;
        return await operation();
      },
      {
        enableAgenticWorkspace: true,
        workspaceDir,
      },
    );

    const tool = tools.find((candidate) => candidate.name === UPLOAD_FILE_TOOL);
    if (tool === undefined) {
      throw new Error("upload tool missing");
    }

    const result = (await executeUploadTool(tool, {
      path: "/workspace/report.txt",
    })) as any;

    expect(runDiscordActionCalls).toBe(1);
    expect(sentName).toBe("report.txt");
    expect(sentAttachment).toBe(filePath);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain(
      `Uploaded file report.txt from /workspace/report.txt (${Buffer.byteLength("hello world")} bytes).`,
    );
  });
});
