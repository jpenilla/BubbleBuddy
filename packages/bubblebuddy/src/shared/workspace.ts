import { posix as posixPath } from "node:path";

import { Effect, FileSystem, Path, Schema } from "effect";

export const sanitizeAttachmentFilename = (filename: string): string => {
  const base = filename.trim().split("/").at(-1)?.split("\\").at(-1) ?? "";
  const sanitized = base
    .replaceAll("\0", "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") return "file";
  if (sanitized.length > 120) {
    const truncated = sanitized.slice(0, 120).trim();
    return truncated.length === 0 ? "file" : truncated;
  }
  return sanitized;
};

export type DualPath = {
  readonly host: string;
  readonly container: string;
};

export type MountedWorkspace = {
  readonly root: DualPath;
  resolve(...segments: string[]): DualPath;
  inside(
    agentPath: string,
  ): Effect.Effect<DualPath, WorkspacePathError, FileSystem.FileSystem | Path.Path>;
};

export class WorkspacePathError extends Schema.TaggedError<WorkspacePathError>()(
  "WorkspacePathError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const channelHostWorkspaceDir = (path: Path.Path, appHome: string, channelId: string) =>
  path.join(appHome, "channel", channelId, "workspace");

export const channelHostSessionsDir = (path: Path.Path, appHome: string, channelId: string) =>
  path.join(appHome, "channel", channelId, "sessions");

export const makeChannelMountedWorkspace = (
  path: Path.Path,
  appHome: string,
  channelId: string,
  containerRoot: string,
): MountedWorkspace =>
  makeMountedWorkspace(path, channelHostWorkspaceDir(path, appHome, channelId), containerRoot);

export const makeMountedWorkspace = (
  path: Path.Path,
  hostDir: string,
  containerRoot: string,
): MountedWorkspace => ({
  root: { host: hostDir, container: containerRoot },
  resolve: (...segments: string[]): DualPath => ({
    host: path.resolve(hostDir, ...segments),
    container: posixPath.resolve(containerRoot, ...segments),
  }),
  inside: Effect.fn("MountedWorkspace.inside")(function* (agentPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const rawPath = agentPath.trim();
    if (rawPath.length === 0)
      return yield* new WorkspacePathError({ message: "Path must not be empty." });

    let workspaceRelativePath: string;
    if (rawPath.startsWith(`${containerRoot}/`)) {
      workspaceRelativePath = rawPath.slice(`${containerRoot}/`.length);
    } else if (rawPath === containerRoot) {
      return yield* new WorkspacePathError({
        message: `${containerRoot} is a directory. Provide a file path.`,
      });
    } else if (path.isAbsolute(rawPath)) {
      return yield* new WorkspacePathError({
        message: `Absolute paths outside ${containerRoot} are not allowed.`,
      });
    } else {
      workspaceRelativePath = rawPath;
    }

    const workspaceRoot = path.resolve(hostDir);
    const candidatePath = path.resolve(workspaceRoot, workspaceRelativePath);
    const realWorkspaceRoot = yield* fs
      .realPath(workspaceRoot)
      .pipe(Effect.orElseSucceed(() => workspaceRoot));
    const realCandidatePath = yield* fs.realPath(candidatePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspacePathError({
            message: `File not found in ${containerRoot}: ${agentPath}`,
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
      return yield* new WorkspacePathError({
        message: `File resolves outside ${containerRoot}: ${agentPath}`,
      });
    }

    return {
      host: realCandidatePath,
      container: posixPath.resolve(containerRoot, relativePath.replaceAll(path.sep, "/")),
    };
  }),
});
