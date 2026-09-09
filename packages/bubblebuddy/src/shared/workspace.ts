import { posix as posixPath } from "node:path";

import { Path } from "effect";

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
};

const channelHostWorkspaceDir = (path: Path.Path, appHome: string, channelId: string) =>
  path.join(appHome, "channel", channelId, "workspace");

export const channelHostSessionsDir = (path: Path.Path, appHome: string, channelId: string) =>
  path.join(appHome, "channel", channelId, "sessions");

export const createChannelMountedWorkspace = (
  path: Path.Path,
  appHome: string,
  channelId: string,
  containerRoot: string,
): MountedWorkspace =>
  createMountedWorkspace(path, channelHostWorkspaceDir(path, appHome, channelId), containerRoot);

export const createMountedWorkspace = (
  path: Path.Path,
  hostDir: string,
  containerRoot: string,
): MountedWorkspace => ({
  root: { host: hostDir, container: containerRoot },
  resolve: (...segments: string[]): DualPath => ({
    host: path.resolve(hostDir, ...segments),
    container: posixPath.resolve(containerRoot, ...segments),
  }),
});
