import type { Attachment, Message } from "discord.js";
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { sanitizeAttachmentFilename, WorkspacePaths } from "../shared/workspace.ts";

export class MessageAttachments extends Context.Service<
  MessageAttachments,
  {
    readonly save: (message: Message<true>, channelId: string) => Effect.Effect<void>;
  }
>()("bubblebuddy/MessageAttachments") {
  static readonly layerNoDeps = Layer.effect(
    MessageAttachments,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;
      const path = yield* Path.Path;
      const workspacePaths = yield* WorkspacePaths;

      const saveOne = Effect.fn("MessageAttachments.saveOne")(function* (
        att: Attachment,
        dest: string,
      ) {
        const dir = path.dirname(dest);
        const tmpPath = `${dest}.tmp`;

        yield* fs.makeDirectory(dir, { recursive: true });
        yield* Effect.gen(function* () {
          yield* http.get(att.url).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((okResponse) => Stream.run(okResponse.stream, fs.sink(tmpPath))),
            Effect.timeout("90 seconds"),
          );
          yield* fs.rename(tmpPath, dest);
        }).pipe(
          Effect.tapError(() =>
            fs
              .remove(tmpPath, { force: true })
              .pipe(
                Effect.ignore({ log: "Warn", message: `Failed to clean up tmp file ${tmpPath}` }),
              ),
          ),
        );
      });

      const save = Effect.fn("MessageAttachments.save")(
        (message: Message<true>, channelId: string) =>
          Effect.gen(function* () {
            const attachments = [...message.attachments.values()];
            if (attachments.length === 0) return;

            yield* Effect.forEach(
              attachments,
              (att, index) =>
                saveOne(
                  att,
                  path.join(
                    workspacePaths.hostAttachmentDir(channelId, message.id, index),
                    sanitizeAttachmentFilename(att.name),
                  ),
                ).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning(
                      `Failed to fetch attachment [${index}] ${att.name} from ${message.id}`,
                      cause,
                    ),
                  ),
                ),
              { concurrency: 3 },
            );
          }),
      );

      return MessageAttachments.of({ save });
    }),
  );

  static readonly layer = MessageAttachments.layerNoDeps.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(FetchHttpClient.layer),
  );
}
