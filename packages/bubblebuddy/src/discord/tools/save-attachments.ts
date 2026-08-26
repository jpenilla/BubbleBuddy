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
  | { readonly index: number; readonly path: string }
  | { readonly index: number; readonly error: string };

export const saveAttachmentsTool = Effect.fn("saveAttachmentsTool")(function* () {
  const context = yield* DiscordToolContext;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;

  const saveOne = Effect.fn("saveOne")(function* (attachment: Attachment, destination: string) {
    const temporaryPath = `${destination}.tmp`;
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* Effect.gen(function* () {
      yield* http.get(attachment.url).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => Stream.run(response.stream, fs.sink(temporaryPath))),
        Effect.timeout("90 seconds"),
      );
      yield* fs.rename(temporaryPath, destination);
    }).pipe(
      Effect.tapError(() =>
        fs.remove(temporaryPath, { force: true }).pipe(
          Effect.ignore({
            log: "Warn",
            message: `Failed to clean up tmp file ${temporaryPath}`,
          }),
        ),
      ),
    );
  });

  const save = Effect.fn("save")((message: Message<true>, indices?: readonly number[]) =>
    Effect.gen(function* () {
      const attachments = [...message.attachments.values()];
      const selected = indices ?? attachments.map((_, index) => index);

      return yield* Effect.forEach(
        selected,
        (index): Effect.Effect<SaveAttachmentResult> =>
          Effect.gen(function* () {
            const attachment = attachments[index];
            if (attachment === undefined) return { index, error: "not found" };

            const filename = sanitizeAttachmentFilename(attachment.name);
            const destination = path.join(
              workspacePaths.hostAttachmentDir(context.channel.id, message.id, index),
              filename,
            );
            yield* saveOne(attachment, destination);
            return {
              index,
              path: `${WORKSPACE_CWD}/${ATTACHMENTS_SEGMENT}/${message.id}/${index}/${filename}`,
            };
          }).pipe(Effect.catch((error) => Effect.succeed({ index, error: String(error) }))),
        { concurrency: 3 },
      );
    }),
  );

  return defineEffectTool({
    name: "discord_save_attachments",
    label: "Save Attachments",
    description: "Save message attachments into /workspace. Omit indices to save all.",
    promptSnippet: "Save message attachments into /workspace",
    parameters: Type.Object({
      messageId: Type.String({ description: "Message ID" }),
      indices: Type.Optional(
        Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, uniqueItems: true }),
      ),
    }),
    execute: (_toolCallId, params) =>
      Effect.gen(function* () {
        const message = yield* tryDiscordJsPromise(() =>
          context.channel.messages.fetch(params.messageId),
        );
        const results = yield* save(message, params.indices);
        return {
          content: [
            {
              type: "text",
              text: results
                .map((result) =>
                  "path" in result
                    ? `[${result.index}] ${result.path}`
                    : `[${result.index}] error: ${result.error}`,
                )
                .join("\n"),
            },
          ],
          details: undefined,
        };
      }),
  });
});
