import { open } from "node:fs/promises";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { GuildPremiumTier, type GuildTextBasedChannel } from "discord.js";
import { Effect, FileSystem, Path } from "effect";

import { ChannelWorkspace, DiscordToolContext } from "../src/discord/tool-context.ts";
import { uploadFileTool } from "../src/discord/tools/upload-file.ts";
import type { ExecuteOrderedDiscordAction } from "../src/discord/session-output-pump.ts";
import { WORKSPACE_CWD } from "../src/shared/constants.ts";
import { createMountedWorkspace } from "../src/shared/workspace.ts";

const extensionContext = {} as ExtensionContext;
const passthrough: ExecuteOrderedDiscordAction = (operation) => operation;

const createChannel = (
  premiumTier: GuildPremiumTier,
  onSend: (payload: { body?: unknown; files?: unknown }) => void = () => undefined,
): GuildTextBasedChannel =>
  ({
    id: "channel-id",
    client: {
      options: {},
      rest: {
        post: async (_route: string, payload: { body?: unknown; files?: unknown }) => {
          onSend(payload);
        },
      },
    },
    guild: { premiumTier },
  }) as unknown as GuildTextBasedChannel;

const createTool = (
  channel: GuildTextBasedChannel,
  workspaceDir: string,
  executeOrdered: ExecuteOrderedDiscordAction = passthrough,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* uploadFileTool.pipe(
      Effect.provideService(
        ChannelWorkspace,
        ChannelWorkspace.of(createMountedWorkspace(fs, path, workspaceDir, WORKSPACE_CWD)),
      ),
      Effect.provideService(DiscordToolContext, DiscordToolContext.of({ channel, executeOrdered })),
    );
  });

const execute = (tool: ToolDefinition, path: string) =>
  tool.execute("tool-call", { path }, undefined, undefined, extensionContext);

const createWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "bubblebuddy-upload-" });
});

const createSparseFile = (path: string, size: number) =>
  Effect.acquireUseRelease(
    Effect.promise(() => open(path, "w")),
    (handle) => Effect.promise(() => handle.truncate(size)),
    (handle) => Effect.promise(() => handle.close()),
  );

it.layer(NodeServices.layer)("upload file tool", (it) => {
  it.effect("rejects paths outside workspace", () =>
    Effect.gen(function* () {
      const workspace = yield* createWorkspace;
      const tool = yield* createTool(createChannel(GuildPremiumTier.None), workspace);

      yield* Effect.promise(() =>
        expect(execute(tool, "/etc/passwd")).rejects.toThrow(
          "Absolute paths outside /workspace are not allowed.",
        ),
      );
    }),
  );

  it.effect("uploads a workspace file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* createWorkspace;
      yield* fs.writeFileString(path.join(workspace, "report.txt"), "hello world");

      let sent: { body?: unknown; files?: unknown } | undefined;
      const tool = yield* createTool(
        createChannel(GuildPremiumTier.None, (payload) => {
          sent = payload;
        }),
        workspace,
      );
      const result = yield* Effect.promise(() => execute(tool, "/workspace/report.txt"));

      const files = sent?.files as
        | Array<{ readonly data: Buffer; readonly name: string }>
        | undefined;
      const attachment = files?.[0];
      expect(attachment?.name).toBe("report.txt");
      expect(attachment?.data).toEqual(Buffer.from("hello world"));
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Uploaded file report.txt from /workspace/report.txt (11 bytes).",
        },
      ]);
    }),
  );

  for (const testCase of [
    {
      name: "default tier",
      premiumTier: GuildPremiumTier.None,
      size: 10 * 1024 * 1024 + 1,
      limit: 10 * 1024 * 1024,
    },
    {
      name: "tier 2",
      premiumTier: GuildPremiumTier.Tier2,
      size: 50 * 1000 * 1000 + 1,
      limit: 50 * 1000 * 1000,
    },
    {
      name: "tier 3 and above",
      premiumTier: (GuildPremiumTier.Tier3 + 1) as GuildPremiumTier,
      size: 100 * 1000 * 1000 + 1,
      limit: 100 * 1000 * 1000,
    },
  ]) {
    it.effect(`enforces the ${testCase.name} upload limit`, () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const workspace = yield* createWorkspace;
        yield* createSparseFile(path.join(workspace, "large.bin"), testCase.size);
        const tool = yield* createTool(createChannel(testCase.premiumTier), workspace);

        yield* Effect.promise(() =>
          expect(execute(tool, "/workspace/large.bin")).rejects.toThrow(
            `exceeds this server's upload limit of ${testCase.limit} bytes`,
          ),
        );
      }),
    );
  }
});
