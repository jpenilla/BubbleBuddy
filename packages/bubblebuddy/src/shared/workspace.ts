import { posix as posixPath } from "node:path";

import { Effect, FileSystem, Path, Schema } from "effect";

export const sanitizeAttachmentFilename = (filename: string): string => {
  const base = filename.trim().split("/").at(-1)?.split("\\").at(-1) ?? "";
  const sanitized = base
    .replaceAll("\0", "")
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") return "file";
  if (sanitized.length > 120) {
    const dotIndex = sanitized.lastIndexOf(".");
    const extension =
      dotIndex > 0 && sanitized.length - dotIndex <= 20 ? sanitized.slice(dotIndex) : "";
    const stem = sanitized.slice(0, 120 - extension.length).trim();
    return `${stem}${extension}`;
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
  ensureDirectory(...segments: string[]): Effect.Effect<DualPath, WorkspacePathError>;
  inside(agentPath: string): Effect.Effect<DualPath, WorkspacePathError>;
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

const isOutside = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

export const channelHostSessionsDir = (path: Path.Path, appHome: string, channelId: string) =>
  path.join(appHome, "channel", channelId, "sessions");

export const createChannelMountedWorkspace = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  appHome: string,
  channelId: string,
  containerRoot: string,
): MountedWorkspace =>
  createMountedWorkspace(
    fs,
    path,
    channelHostWorkspaceDir(path, appHome, channelId),
    containerRoot,
  );

export const createMountedWorkspace = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  hostDir: string,
  containerRoot: string,
): MountedWorkspace => ({
  root: { host: hostDir, container: containerRoot },
  resolve: (...segments: string[]): DualPath => ({
    host: path.resolve(hostDir, ...segments),
    container: posixPath.resolve(containerRoot, ...segments),
  }),
  ensureDirectory: Effect.fn("MountedWorkspace.ensureDirectory")(
    function* (...segments: string[]) {
      const workspaceRoot = path.resolve(hostDir);
      const candidatePath = path.resolve(workspaceRoot, ...segments);
      if (isOutside(path, workspaceRoot, candidatePath)) {
        return yield* new WorkspacePathError({ message: "Directory resolves outside workspace." });
      }

      const realWorkspaceRoot = yield* fs.realPath(workspaceRoot);
      let existingPath = candidatePath;
      while (!(yield* fs.exists(existingPath))) {
        existingPath = path.dirname(existingPath);
      }
      const realExistingPath = yield* fs.realPath(existingPath);
      if (isOutside(path, realWorkspaceRoot, realExistingPath)) {
        return yield* new WorkspacePathError({ message: "Directory resolves outside workspace." });
      }

      yield* fs.makeDirectory(candidatePath, { recursive: true });
      const realCandidatePath = yield* fs.realPath(candidatePath);
      if (isOutside(path, realWorkspaceRoot, realCandidatePath)) {
        return yield* new WorkspacePathError({ message: "Directory resolves outside workspace." });
      }
      const relativePath = path.relative(realWorkspaceRoot, realCandidatePath);
      return {
        host: realCandidatePath,
        container: posixPath.resolve(containerRoot, relativePath.replaceAll(path.sep, "/")),
      };
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkspacePathError
            ? cause
            : new WorkspacePathError({ message: "Could not create workspace directory.", cause }),
        ),
      ),
  ),
  inside: Effect.fn("MountedWorkspace.inside")(function* (agentPath: string) {
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
    if (isOutside(path, realWorkspaceRoot, realCandidatePath)) {
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
