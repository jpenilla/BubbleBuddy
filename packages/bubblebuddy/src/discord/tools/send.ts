import { type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { NodeStream } from "@effect/platform-node";
import { GuestPath } from "incus-api";
import { GuildPremiumTier, type GuildTextBasedChannel } from "discord.js";
import { Effect, Ref, Stream } from "effect";
import { posix } from "node:path";
import { Type } from "typebox";

import { listUsableStickers } from "../assets.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { sendChunkedMessage, sendMessage } from "../utils.ts";
import { AgentToolError, defineEffectTool } from "../../pi/effect-tool.ts";
import { DISCORD_SAFE_MESSAGE_LIMIT } from "../../shared/constants.ts";
import { SessionContainer } from "../../session/session-container.ts";

const MAX_STICKERS = 3;
const MAX_FILES = 10;

const getGuildUploadLimit = (premiumTier: GuildPremiumTier): bigint => {
  if (premiumTier >= GuildPremiumTier.Tier3) return 100_000_000n; // 100 MB
  if (premiumTier >= GuildPremiumTier.Tier2) return 50_000_000n; // 50 MB
  return 10_485_760n; // 10 MiB
};

const resolveGuestPath = (cwd: GuestPath.GuestPath, inputPath: string) => {
  const rawPath = inputPath.trim();
  if (rawPath.length === 0) {
    return Effect.fail(new AgentToolError({ message: "File path must not be empty." }));
  }
  return GuestPath.resolve(cwd, rawPath);
};

const replyOptions = (params: { replyTo?: string; ping?: boolean }) =>
  params.replyTo === undefined
    ? undefined
    : {
        reply: {
          messageReference: params.replyTo,
          failIfNotExists: true,
        },
        allowedMentions:
          params.ping === false
            ? { parse: ["users", "roles", "everyone"] as const, repliedUser: false }
            : undefined,
      };

const sentResult = (terminate: boolean): AgentToolResult<undefined> => ({
  content: [{ type: "text", text: "Sent message." }],
  details: undefined,
  terminate,
});

type FileSendParams = { readonly filePaths?: readonly string[] };

export const makeSendTool = Effect.fn("makeSendTool")(function* (options: {
  readonly enableAgenticWorkspace: boolean;
}) {
  const enableFiles = options.enableAgenticWorkspace;
  return yield* defineEffectTool({
    name: "discord_send",
    label: "Send",
    description: enableFiles
      ? "Send a message with a reply reference, stickers, or file attachments. Requires at least one of replyTo, stickerIds, or filePaths."
      : "Send a message with a reply reference or stickers. Requires at least one of replyTo or stickerIds.",
    promptGuidelines: [
      enableFiles
        ? "discord_send adds Discord-specific delivery options: a reply reference with optional author notification, stickers, and file attachments."
        : "discord_send adds Discord-specific delivery options: a reply reference with optional author notification and stickers.",
      enableFiles
        ? "A discord_send call with stickers or files is a single message, so keep its text within the character limit; text-only replies may be any length and are split automatically."
        : "A discord_send call with stickers is a single message, so keep its text within the character limit; text-only replies may be any length and are split automatically.",
      "Use discord_send during a turn as needed. For a send that completes the response, include any closing text in content.",
    ],
    parameters: Type.Object({
      content: Type.Optional(
        Type.String({
          description: enableFiles
            ? "Message text; required unless sending stickers or files"
            : "Message text; required unless sending stickers",
        }),
      ),
      replyTo: Type.Optional(Type.String({ description: "ID of the message to reply to" })),
      ping: Type.Optional(
        Type.Boolean({
          description:
            "Notify the author of the replied-to message (default true; only applies with replyTo). Explicit mentions in content are unaffected.",
        }),
      ),
      stickerIds: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: MAX_STICKERS,
          description: `Sticker IDs (up to ${MAX_STICKERS})`,
        }),
      ),
      terminate: Type.Boolean({
        description: "End the turn after this send succeeds.",
      }),
      ...(enableFiles
        ? {
            filePaths: Type.Optional(
              Type.Array(Type.String(), {
                minItems: 1,
                maxItems: MAX_FILES,
                description: `Paths of files in the container to upload (up to ${MAX_FILES}); may be absolute or relative to /workspace`,
              }),
            ),
          }
        : {}),
    }),
    executionMode: "sequential",
    execute: (_toolCallId, params) =>
      Effect.gen(function* () {
        const context = yield* DiscordToolContext;
        const { content, replyTo, ping, stickerIds, terminate } = params;
        const filePaths = enableFiles ? (params as FileSendParams).filePaths : undefined;
        const hasAttachments =
          (stickerIds !== undefined && stickerIds.length > 0) ||
          (filePaths !== undefined && filePaths.length > 0);

        if (replyTo === undefined && !hasAttachments) {
          return yield* new AgentToolError({
            message: enableFiles
              ? "discord_send requires at least one of replyTo, stickerIds, or filePaths. Use ordinary response text for normal messages."
              : "discord_send requires at least one of replyTo or stickerIds. Use ordinary response text for normal messages.",
          });
        }
        if (ping !== undefined && replyTo === undefined) {
          return yield* new AgentToolError({
            message: "ping only applies when replyTo is set.",
          });
        }
        if (
          hasAttachments &&
          content !== undefined &&
          content.length > DISCORD_SAFE_MESSAGE_LIMIT
        ) {
          return yield* new AgentToolError({
            message: `Message text is ${content.length} characters; keep it within ${DISCORD_SAFE_MESSAGE_LIMIT} characters when sending stickers or files. Send long text in your normal response instead.`,
          });
        }

        if (!hasAttachments) {
          if (content === undefined || content.trim().length === 0) {
            return yield* new AgentToolError({
              message: "content is required unless sending stickers or files.",
            });
          }
          yield* context.executeOrdered(
            sendChunkedMessage({
              channel: context.channel,
              content,
              ...replyOptions({ replyTo, ping }),
            }),
          );
          return sentResult(terminate);
        }

        const stickers =
          stickerIds === undefined ? [] : yield* resolveStickers(context, stickerIds);
        const files = filePaths === undefined ? [] : yield* resolveFiles(context, filePaths);

        yield* context.executeOrdered(
          sendMessage(context.channel, {
            content,
            stickers,
            files,
            ...replyOptions({ replyTo, ping }),
          }),
        );

        return sentResult(terminate);
      }),
  });
});

const resolveStickers = (
  context: { channel: GuildTextBasedChannel },
  stickerIds: readonly string[],
) =>
  Effect.gen(function* () {
    const stickers = yield* listUsableStickers(context);
    const resolved: string[] = [];
    const missing: string[] = [];
    for (const id of stickerIds) {
      if (stickers.some(({ sticker }) => sticker.id === id)) {
        resolved.push(id);
      } else {
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      return yield* new AgentToolError({
        message: `Sticker(s) not available here: ${missing.join(", ")}.`,
      });
    }
    return resolved;
  });

const resolveFiles = (
  context: { channel: { guild: { premiumTier: GuildPremiumTier } } },
  filePaths: readonly string[],
) =>
  Effect.gen(function* () {
    const sessionContainer = yield* SessionContainer.Service;
    const container = yield* sessionContainer.get;
    const limit = getGuildUploadLimit(context.channel.guild.premiumTier);

    return yield* Effect.forEach(filePaths, (inputPath) =>
      Effect.gen(function* () {
        const guestPath = yield* resolveGuestPath(sessionContainer.cwd, inputPath);
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

        return {
          attachment: readable,
          name: posix.basename(guestPath),
        };
      }),
    );
  });
