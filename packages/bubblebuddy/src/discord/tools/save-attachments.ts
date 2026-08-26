import type { Attachment, Message } from "discord.js";
import { Effect, FileSystem, Path, Stream } from "effect";
import { Type } from "typebox";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { sanitizeAttachmentFilename, WorkspacePaths } from "../../shared/workspace.ts";
import { ATTACHMENTS_SEGMENT, WORKSPACE_CWD } from "../../shared/constants.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { defineEffectTool } from "../../tools/effect-tool.ts";

type SaveAttachmentResult =
  | { readonly kind: "saved"; readonly index: number; readonly path: string }
  | { readonly kind: "failed"; readonly index: number; readonly error: string };

const saved = (index: number, path: string): SaveAttachmentResult => ({
  kind: "saved",
  index,
  path,
});
const failed = (index: number, error: string): SaveAttachmentResult => ({
  kind: "failed",
  index,
  error,
});

const formatSaveAttachmentResult = (result: SaveAttachmentResult): string => {
  switch (result.kind) {
    case "saved":
      return `[${result.index}] ${result.path}`;
    case "failed":
      return `[${result.index}] error: ${result.error}`;
  }
};

const saveDiscordAttachment = Effect.fn("saveDiscordAttachment")(function* (
  attachment: Attachment,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const temporaryPath = `${destination}.${crypto.randomUUID()}.tmp`;
  yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
  yield* Effect.gen(function* () {
    yield* http.get(attachment.url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => Stream.run(response.stream, fs.sink(temporaryPath))),
    );
    yield* fs.rename(temporaryPath, destination);
  }).pipe(
    Effect.ensuring(
      fs.remove(temporaryPath, { force: true }).pipe(
        Effect.ignore({
          log: "Warn",
          message: `Failed to clean up tmp file ${temporaryPath}`,
        }),
      ),
    ),
  );
});

const saveDiscordMessageAttachments = Effect.fn("saveDiscordMessageAttachments")(function* (
  channelId: string,
  message: Message<true>,
  indices?: readonly number[],
) {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const attachments = [...message.attachments.values()];
  const selected = indices ?? attachments.map((_, index) => index);

  return yield* Effect.forEach(
    selected,
    (index) =>
      Effect.gen(function* () {
        const attachment = attachments[index];
        if (attachment === undefined) return failed(index, "not found");

        const filename = sanitizeAttachmentFilename(attachment.name);
        const destination = path.join(
          workspacePaths.hostAttachmentDir(channelId, message.id, index),
          filename,
        );
        yield* saveDiscordAttachment(attachment, destination);
        return saved(
          index,
          `${WORKSPACE_CWD}/${ATTACHMENTS_SEGMENT}/${message.id}/${index}/${filename}`,
        );
      }).pipe(
        Effect.tapError((error) => Effect.logDebug("Failed to save Discord attachment", error)),
        Effect.catch((error) => Effect.succeed(failed(index, error.message))),
      ),
    { concurrency: 3 },
  );
});

export const saveAttachmentsTool = defineEffectTool({
  name: "discord_save_attachments",
  label: "Save Attachments",
  description: "Save message attachments into /workspace. Omit indices to save all.",
  promptSnippet: "Save message attachments into /workspace. Omit indices to save all",
  parameters: Type.Object({
    messageId: Type.String({ description: "Message ID" }),
    indices: Type.Optional(
      Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, uniqueItems: true }),
    ),
  }),
  execute: (_toolCallId, params) =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const message = yield* tryDiscordJsPromise(() =>
        context.channel.messages.fetch(params.messageId),
      );
      const results = yield* saveDiscordMessageAttachments(
        context.channel.id,
        message,
        params.indices,
      );
      return {
        content: [
          {
            type: "text",
            text: results.map(formatSaveAttachmentResult).join("\n"),
          },
        ],
        details: undefined,
      };
    }),
});
