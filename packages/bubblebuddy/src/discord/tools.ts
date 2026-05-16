import { realpath, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Client, type Guild, type GuildTextBasedChannel } from "discord.js";
import { Cause, Effect, Exit } from "effect";

import {
  formatCustomEmojiMessageSyntax,
  formatCustomEmojiReactionSyntax,
  listUsableCustomEmojis,
  listUsableStickers,
  normalizeReactionEmoji,
  type DiscordAssetContext,
} from "./assets.ts";
import { formatMessageForPrompt } from "./message-formatting.ts";
import { WORKSPACE_CWD } from "../shared/constants.ts";
import type { AwaitToolDiscordAction } from "../pi-session/discord-output-pump.ts";
import { sendMessageWithAbort } from "./utils.ts";

const LIST_CUSTOM_EMOJIS_TOOL = "discord_list_custom_emojis";
const LIST_STICKERS_TOOL = "discord_list_stickers";
const SEND_STICKER_TOOL = "discord_send_sticker";
const UPLOAD_FILE_TOOL = "discord_upload_file";
const REACT_TOOL = "discord_react";
const FETCH_MESSAGE_TOOL = "discord_fetch_message";

const formatEmojiList = (context: DiscordToolContext): string => {
  const emojis = listUsableCustomEmojis(context);
  if (emojis.length === 0) {
    return "No custom emojis are available here.";
  }

  return [
    "Custom emojis you can use here:",
    ...emojis.map((emoji) => {
      const messageSyntax = formatCustomEmojiMessageSyntax(emoji);
      const reactionSyntax = formatCustomEmojiReactionSyntax(emoji);
      return `- :${emoji.name}: message=\`${messageSyntax}\` reaction=\`${reactionSyntax}\``;
    }),
    "Always use the exact correct syntax for the use case. Do not escape or show the plain name unless a task explicitly needs it or a user asks.",
  ].join("\n");
};

const formatStickerList = async (context: DiscordToolContext): Promise<string> => {
  const stickers = await listUsableStickers(context);
  if (stickers.length === 0) {
    return "No stickers are available here.";
  }

  return [
    "Stickers you can send here:",
    ...stickers.map(({ guildName, packName, sticker }) => {
      const source = guildName !== null ? `guild=${guildName}` : `pack=${packName ?? "unknown"}`;
      const tags = sticker.tags ? ` tags=${sticker.tags}` : "";
      return `- id=${sticker.id} name=${sticker.name} ${source}${tags}`;
    }),
  ].join("\n");
};

const resolveWorkspaceFile = async (
  workspaceDir: string,
  inputPath: string,
): Promise<{ hostPath: string; size: number; workspacePath: string }> => {
  const rawPath = inputPath.trim();
  if (rawPath.length === 0) {
    throw new Error("Path must not be empty.");
  }

  let workspaceRelativePath: string;
  if (rawPath.startsWith(`${WORKSPACE_CWD}/`)) {
    workspaceRelativePath = rawPath.slice(`${WORKSPACE_CWD}/`.length);
  } else if (rawPath === WORKSPACE_CWD) {
    throw new Error(`${WORKSPACE_CWD} is a directory. Provide a file path.`);
  } else if (rawPath.startsWith("/")) {
    throw new Error(`Absolute paths outside ${WORKSPACE_CWD} are not allowed.`);
  } else {
    workspaceRelativePath = rawPath;
  }

  const workspaceRoot = resolve(workspaceDir);
  const candidatePath = resolve(workspaceRoot, workspaceRelativePath);

  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = await realpath(workspaceRoot);
  } catch {
    realWorkspaceRoot = workspaceRoot;
  }

  let realCandidatePath: string;
  try {
    realCandidatePath = await realpath(candidatePath);
  } catch {
    throw new Error(`File not found in ${WORKSPACE_CWD}: ${inputPath}`);
  }

  const rel = relative(realWorkspaceRoot, realCandidatePath);
  if (rel === ".." || rel.startsWith(`../`) || rel.startsWith(`..\\`)) {
    throw new Error(`File resolves outside ${WORKSPACE_CWD}: ${inputPath}`);
  }

  const fileStat = await stat(realCandidatePath).catch(() => null);
  if (fileStat === null || !fileStat.isFile()) {
    throw new Error(`Path is not a regular file: ${inputPath}`);
  }

  const normalizedRelative = relative(realWorkspaceRoot, realCandidatePath).replaceAll("\\", "/");
  return {
    hostPath: realCandidatePath,
    size: fileStat.size,
    workspacePath: `${WORKSPACE_CWD}/${normalizedRelative}`,
  };
};

const runToolEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
  signal: AbortSignal | undefined,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, { signal });

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  if (signal?.aborted === true || Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error("Operation aborted.");
  }

  throw Cause.squash(exit.cause);
};

const getGuildUploadLimit = (context: DiscordToolContext): number => {
  switch (context.guild.premiumTier) {
    case 3:
      return 100 * 1000 * 1000;
    case 2:
      return 50 * 1000 * 1000;
    default:
      return 10 * 1024 * 1024;
  }
};

export interface DiscordToolOptions {
  readonly enableAgenticWorkspace: boolean;
  readonly workspaceDir: string;
}

export type DiscordToolContext = DiscordAssetContext & {
  readonly channel: GuildTextBasedChannel;
  readonly client: Client<true>;
  readonly guild: Guild;
};

export const createDiscordTools = (
  context: DiscordToolContext,
  awaitToolDiscordAction: AwaitToolDiscordAction,
  options: DiscordToolOptions,
): ToolDefinition[] => {
  const tools: ToolDefinition[] = [
    defineTool({
      name: LIST_CUSTOM_EMOJIS_TOOL,
      label: "List Custom Emojis",
      description: "List custom emojis usable here, including exact text and reaction syntax.",
      promptSnippet: "List custom emojis usable here, including exact text and reaction syntax",
      promptGuidelines: [
        `For custom emojis, always use exact syntax from ${LIST_CUSTOM_EMOJIS_TOOL} in text and reactions.`,
      ],
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: formatEmojiList(context) }],
        details: {},
      }),
    }),
    defineTool({
      name: LIST_STICKERS_TOOL,
      label: "List Stickers",
      description: "List stickers usable here.",
      promptSnippet: "List stickers usable here",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: await formatStickerList(context) }],
        details: {},
      }),
    }),
    defineTool({
      name: SEND_STICKER_TOOL,
      label: "Send Sticker",
      description: "Send one sticker.",
      promptSnippet: "Send one sticker",
      parameters: Type.Object({
        caption: Type.Optional(
          Type.String({
            description: "Optional message text to send with the sticker",
          }),
        ),
        stickerId: Type.String({ description: "Sticker ID" }),
      }),
      execute: async (_toolCallId, params, signal) => {
        const stickers = await listUsableStickers(context);
        const sticker = stickers.find((candidate) => candidate.sticker.id === params.stickerId);

        if (sticker === undefined) {
          throw new Error(`Sticker ${params.stickerId} is not available here.`);
        }

        await runToolEffect(
          awaitToolDiscordAction(
            Effect.tryPromise({
              try: () =>
                context.channel.send({
                  content: params.caption,
                  stickers: [sticker.sticker.id],
                }),
              catch: (cause) => cause,
            }),
          ),
          signal,
        );

        return {
          content: [
            {
              type: "text",
              text: `Sent sticker ${sticker.sticker.name} (${sticker.sticker.id}).`,
            },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: REACT_TOOL,
      label: "React",
      description: "React to a message in the current channel.",
      promptSnippet: "React to a message in the current channel",
      parameters: Type.Object({
        emojis: Type.Array(Type.String({ description: "Emoji reaction to add" })),
        messageId: Type.String({ description: "Discord message ID" }),
      }),
      execute: async (_toolCallId, params, signal) => {
        const targetMessage = await runToolEffect(
          Effect.tryPromise({
            try: () => context.channel.messages.fetch(params.messageId),
            catch: (cause) => cause,
          }),
          signal,
        );

        const failures: string[] = [];

        for (const input of params.emojis) {
          const emoji = normalizeReactionEmoji(context, input);
          if (emoji === null) {
            failures.push(`${input}: invalid or not available`);
            continue;
          }

          try {
            await runToolEffect(
              awaitToolDiscordAction(
                Effect.tryPromise({
                  try: () => targetMessage.react(emoji),
                  catch: (cause) => cause,
                }),
              ),
              signal,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`${emoji}: ${message}`);
          }

          if (signal?.aborted === true) {
            throw new Error("Operation aborted.");
          }
        }

        if (failures.length > 0) {
          throw new Error(`Failed to add reactions: ${failures.join("; ")}`);
        }

        return {
          content: [{ type: "text", text: "Reactions added." }],
          details: {},
        };
      },
    }),
    defineTool({
      name: FETCH_MESSAGE_TOOL,
      label: "Fetch Message",
      description: "Fetch a message in the current Discord channel.",
      promptSnippet: "Fetch a message in the current Discord channel",
      promptGuidelines: [
        "When a message replies to or otherwise references a message ID you do not recognize, you may attempt to fetch it",
      ],
      parameters: Type.Object({
        messageId: Type.String({ description: "Message ID" }),
      }),
      execute: async (_toolCallId, params, signal) => {
        const fetchedMessage = await runToolEffect(
          Effect.tryPromise({
            try: () => context.channel.messages.fetch(params.messageId),
            catch: (cause) => cause,
          }),
          signal,
        );

        return {
          content: [{ type: "text", text: formatMessageForPrompt(fetchedMessage) }],
          details: {},
        };
      },
    }),
  ];

  if (options.enableAgenticWorkspace) {
    tools.push(
      defineTool({
        name: UPLOAD_FILE_TOOL,
        label: "Upload File",
        description:
          "Upload file from /workspace into chat; path may be absolute or relative to /workspace.",
        promptSnippet:
          "Upload file from /workspace into chat; path may be absolute or relative to /workspace",
        parameters: Type.Object({
          caption: Type.Optional(
            Type.String({
              description: "Optional message text to send with the uploaded file",
            }),
          ),
          fileName: Type.Optional(
            Type.String({ description: "Optional attachment file name override" }),
          ),
          path: Type.String({
            description: "Path of file to upload",
          }),
        }),
        execute: async (_toolCallId, params, signal) => {
          const resolved = await resolveWorkspaceFile(options.workspaceDir, params.path);

          const limit = getGuildUploadLimit(context);
          if (resolved.size > limit) {
            throw new Error(
              `File size ${resolved.size} exceeds this server's upload limit of ${limit} bytes.`,
            );
          }

          const fileName = params.fileName?.trim() || basename(resolved.hostPath);
          await runToolEffect(
            awaitToolDiscordAction(
              Effect.tryPromise({
                try: (signal) =>
                  sendMessageWithAbort(context.channel, signal, {
                    content: params.caption,
                    files: [{ attachment: resolved.hostPath, name: fileName }],
                  }),
                catch: (cause) => cause,
              }),
            ),
            signal,
          );

          return {
            content: [
              {
                type: "text",
                text: `Uploaded file ${fileName} from ${resolved.workspacePath} (${resolved.size} bytes).`,
              },
            ],
            details: {},
          };
        },
      }),
    );
  }

  return tools;
};
