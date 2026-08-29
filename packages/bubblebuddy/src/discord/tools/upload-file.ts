import { GuildPremiumTier } from "discord.js";
import { Effect, FileSystem, Path } from "effect";
import { Type } from "typebox";

import { ChannelWorkspace, DiscordToolContext } from "../tool-context.ts";
import { sendMessageWithAbort, tryDiscordJsPromise } from "../utils.ts";
import { AgentToolError, defineEffectTool } from "../../pi/effect-tool.ts";

const getGuildUploadLimit = (premiumTier: GuildPremiumTier): bigint => {
  if (premiumTier >= GuildPremiumTier.Tier3) return 100_000_000n; // 100 MB
  if (premiumTier === GuildPremiumTier.Tier2) return 50_000_000n; // 50 MB
  return 10_485_760n; // 10 MiB
};

const resolveWorkspaceFile = Effect.fn("resolveWorkspaceFile")(function* (inputPath: string) {
  const workspace = yield* ChannelWorkspace;
  const fs = yield* FileSystem.FileSystem;
  const dual = yield* workspace.inside(inputPath).pipe(
    Effect.mapError(
      (error) =>
        new AgentToolError({
          message: error.message,
          ...(error.cause !== undefined ? { cause: error.cause } : {}),
        }),
    ),
  );

  const info = yield* fs
    .stat(dual.host)
    .pipe(
      Effect.mapError(
        (cause) => new AgentToolError({ message: `Path cannot be read: ${inputPath}`, cause }),
      ),
    );
  if (info.type !== "File")
    return yield* new AgentToolError({ message: `Path is not a regular file: ${inputPath}` });

  return { ...dual, size: info.size };
});

export const uploadFileTool = defineEffectTool({
  name: "discord_upload_file",
  label: "Upload File",
  description:
    "Upload file from /workspace into chat; path may be absolute or relative to /workspace.",
  promptSnippet:
    "Upload file from /workspace into chat; path may be absolute or relative to /workspace",
  parameters: Type.Object({
    caption: Type.Optional(
      Type.String({ description: "Optional message text to send with the uploaded file" }),
    ),
    fileName: Type.Optional(Type.String({ description: "Optional attachment file name override" })),
    path: Type.String({ description: "Path of file to upload" }),
  }),
  execute: (_toolCallId, params) =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const path = yield* Path.Path;
      const resolved = yield* resolveWorkspaceFile(params.path);
      const limit = getGuildUploadLimit(context.channel.guild.premiumTier);
      if (resolved.size > limit) {
        return yield* new AgentToolError({
          message: `File size ${resolved.size} exceeds this server's upload limit of ${limit} bytes.`,
        });
      }

      const fileName = params.fileName?.trim() || path.basename(resolved.host);
      yield* context.awaitAction(
        tryDiscordJsPromise((signal) =>
          sendMessageWithAbort(context.channel, signal, {
            content: params.caption,
            files: [{ attachment: resolved.host, name: fileName }],
          }),
        ),
      );

      return {
        content: [
          {
            type: "text",
            text: `Uploaded file ${fileName} from ${resolved.container} (${resolved.size} bytes).`,
          },
        ],
        details: undefined,
      };
    }),
});
