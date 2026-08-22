import { Context, Effect, Layer, Path } from "effect";

import { AppHome } from "../config/env.ts";
import { ATTACHMENTS_SEGMENT } from "./constants.ts";

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

export interface WorkspacePathsShape {
  readonly hostWorkspaceDir: (channelId: string) => string;
  readonly sessionsDir: (channelId: string) => string;
  readonly hostAttachmentDir: (channelId: string, messageId: string, index: number) => string;
}

export class WorkspacePaths extends Context.Service<WorkspacePaths, WorkspacePathsShape>()(
  "bubblebuddy/WorkspacePaths",
) {
  static readonly layerNoDeps = Layer.effect(
    WorkspacePaths,
    Effect.gen(function* () {
      const appHome = yield* AppHome;
      const path = yield* Path.Path;

      const hostWorkspaceDir = (channelId: string) =>
        path.join(appHome, "channel", channelId, "workspace");
      const sessionsDir = (channelId: string) =>
        path.join(appHome, "channel", channelId, "sessions");
      const hostAttachmentDir = (channelId: string, messageId: string, index: number) =>
        path.join(
          appHome,
          "channel",
          channelId,
          "workspace",
          ATTACHMENTS_SEGMENT,
          messageId,
          String(index),
        );
      return WorkspacePaths.of({
        hostWorkspaceDir,
        sessionsDir,
        hostAttachmentDir,
      });
    }),
  );
  static readonly layer = WorkspacePaths.layerNoDeps.pipe(Layer.provide(AppHome.layer));
}
