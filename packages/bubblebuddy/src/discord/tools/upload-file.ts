import { GuestPath } from "incus-api";
import { NodeStream } from "@effect/platform-node";
import { GuildPremiumTier } from "discord.js";
import { Effect, Ref, Stream } from "effect";
import { posix } from "node:path";
import { Type } from "typebox";

import { AgentToolError, defineEffectTool } from "../../pi/effect-tool.ts";
import { SessionContainer } from "../../session/session-container.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { sendMessage } from "../utils.ts";

const getGuildUploadLimit = (premiumTier: GuildPremiumTier): bigint => {
  if (premiumTier >= GuildPremiumTier.Tier3) return 100_000_000n; // 100 MB
  if (premiumTier === GuildPremiumTier.Tier2) return 50_000_000n; // 50 MB
  return 10_485_760n; // 10 MiB
};

const resolveGuestPath = (cwd: GuestPath.GuestPath, inputPath: string) => {
  const rawPath = inputPath.trim();
  if (rawPath.length === 0) {
    return Effect.fail(new AgentToolError({ message: "Path must not be empty." }));
  }
  return GuestPath.resolve(cwd, rawPath);
};

export const uploadFileTool = defineEffectTool({
  name: "discord_upload_file",
  label: "Upload File",
  description:
    "Upload a file from the container into chat; paths may be absolute or relative to /workspace.",
  parameters: Type.Object({
    caption: Type.Optional(
      Type.String({ description: "Optional message text to send with the uploaded file" }),
    ),
    fileName: Type.Optional(Type.String({ description: "Optional attachment file name override" })),
    path: Type.String({ description: "Container path of file to upload" }),
  }),
  execute: (_toolCallId, params) =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const sessionContainer = yield* SessionContainer.Service;
      const container = yield* sessionContainer.get;
      const guestPath = yield* resolveGuestPath(sessionContainer.cwd, params.path);
      const limit = getGuildUploadLimit(context.channel.guild.premiumTier);
      const file = yield* container.files.readFile(guestPath);
      if (file.size !== undefined && file.size > limit) {
        return yield* new AgentToolError({
          message: `File size ${file.size} exceeds this server's upload limit of ${limit} bytes.`,
        });
      }

      const bytesRead = yield* Ref.make(0n);
      const limited = file.bytes.pipe(
        Stream.tap((chunk) =>
          Ref.updateAndGet(bytesRead, (size) => size + BigInt(chunk.byteLength)).pipe(
            Effect.flatMap((size) =>
              size > limit
                ? Effect.fail(
                    new AgentToolError({
                      message: `File exceeds this server's upload limit of ${limit} bytes.`,
                    }),
                  )
                : Effect.void,
            ),
          ),
        ),
      );
      const readable = yield* NodeStream.toReadable(limited);
      yield* Effect.addFinalizer(() => Effect.sync(() => readable.destroy()));

      const fileName = params.fileName?.trim() || posix.basename(guestPath);
      yield* context.executeOrdered(
        sendMessage(context.channel, {
          content: params.caption,
          files: [{ attachment: readable, name: fileName }],
        }),
      );

      const size = yield* Ref.get(bytesRead);
      return {
        content: [
          {
            type: "text",
            text: `Uploaded file ${fileName} from ${guestPath} (${size} bytes).`,
          },
        ],
        details: undefined,
      };
    }),
});
