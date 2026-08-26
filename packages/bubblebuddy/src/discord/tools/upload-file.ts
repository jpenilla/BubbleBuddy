import { Effect, FileSystem, Path } from "effect";
import { Type } from "typebox";

import { ChannelWorkspace, DiscordToolContext } from "../tool-context.ts";
import { sendMessageWithAbort, tryDiscordJsPromise } from "../utils.ts";
import { WORKSPACE_CWD } from "../../shared/constants.ts";
import { AgentToolError, defineEffectTool } from "../../tools/effect-tool.ts";

export const uploadFileTool = Effect.fn("uploadFileTool")(function* () {
  const context = yield* DiscordToolContext;
  const workspace = yield* ChannelWorkspace;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const getGuildUploadLimit = (): bigint => {
    switch (context.channel.guild.premiumTier) {
      case 3:
        return 100_000_000n;
      case 2:
        return 50_000_000n;
      default:
        return 10_485_760n;
    }
  };

  const resolveWorkspaceFile = Effect.fn("resolveWorkspaceFile")(function* (inputPath: string) {
    const rawPath = inputPath.trim();
    if (rawPath.length === 0)
      return yield* new AgentToolError({ message: "Path must not be empty." });

    let workspaceRelativePath: string;
    if (rawPath.startsWith(`${WORKSPACE_CWD}/`)) {
      workspaceRelativePath = rawPath.slice(`${WORKSPACE_CWD}/`.length);
    } else if (rawPath === WORKSPACE_CWD) {
      return yield* new AgentToolError({
        message: `${WORKSPACE_CWD} is a directory. Provide a file path.`,
      });
    } else if (path.isAbsolute(rawPath)) {
      return yield* new AgentToolError({
        message: `Absolute paths outside ${WORKSPACE_CWD} are not allowed.`,
      });
    } else {
      workspaceRelativePath = rawPath;
    }

    const workspaceRoot = path.resolve(workspace.hostDir);
    const candidatePath = path.resolve(workspaceRoot, workspaceRelativePath);
    const realWorkspaceRoot = yield* fs
      .realPath(workspaceRoot)
      .pipe(Effect.orElseSucceed(() => workspaceRoot));
    const realCandidatePath = yield* fs.realPath(candidatePath).pipe(
      Effect.mapError(
        (cause) =>
          new AgentToolError({
            message: `File not found in ${WORKSPACE_CWD}: ${inputPath}`,
            cause,
          }),
      ),
    );
    const relativePath = path.relative(realWorkspaceRoot, realCandidatePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return yield* new AgentToolError({
        message: `File resolves outside ${WORKSPACE_CWD}: ${inputPath}`,
      });
    }

    const info = yield* fs
      .stat(realCandidatePath)
      .pipe(
        Effect.mapError(
          (cause) => new AgentToolError({ message: `Path cannot be read: ${inputPath}`, cause }),
        ),
      );
    if (info.type !== "File")
      return yield* new AgentToolError({ message: `Path is not a regular file: ${inputPath}` });

    return {
      hostPath: realCandidatePath,
      size: info.size,
      workspacePath: `${WORKSPACE_CWD}/${relativePath.replaceAll(path.sep, "/")}`,
    };
  });

  return defineEffectTool({
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
      fileName: Type.Optional(
        Type.String({ description: "Optional attachment file name override" }),
      ),
      path: Type.String({ description: "Path of file to upload" }),
    }),
    execute: (_toolCallId, params) =>
      Effect.gen(function* () {
        const resolved = yield* resolveWorkspaceFile(params.path);
        const limit = getGuildUploadLimit();
        if (resolved.size > limit) {
          return yield* new AgentToolError({
            message: `File size ${resolved.size} exceeds this server's upload limit of ${limit} bytes.`,
          });
        }

        const fileName = params.fileName?.trim() || path.basename(resolved.hostPath);
        yield* context.awaitAction(
          tryDiscordJsPromise((signal) =>
            sendMessageWithAbort(context.channel, signal, {
              content: params.caption,
              files: [{ attachment: resolved.hostPath, name: fileName }],
            }),
          ),
        );

        return {
          content: [
            {
              type: "text",
              text: `Uploaded file ${fileName} from ${resolved.workspacePath} (${resolved.size} bytes).`,
            },
          ],
          details: undefined,
        };
      }),
  });
});
