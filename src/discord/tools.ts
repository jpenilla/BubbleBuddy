import { readFile, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Message } from "discord.js";

import {
  formatCustomEmojiMessageSyntax,
  formatCustomEmojiReactionSyntax,
  listUsableCustomEmojis,
  listUsableStickers,
  normalizeReactionEmoji,
} from "./assets.ts";

const LIST_CUSTOM_EMOJIS_TOOL = "discord_list_custom_emojis";
const LIST_STICKERS_TOOL = "discord_list_stickers";
const SEND_STICKER_TOOL = "discord_send_sticker";
const UPLOAD_FILE_TOOL = "discord_upload_file";
const REACT_TOOL = "discord_react";

const formatEmojiList = (message: Message<true>): string => {
  const emojis = listUsableCustomEmojis(message);
  if (emojis.length === 0) {
    return "No custom emojis are available here.";
  }

  return [
    "Custom emojis you can use here:",
    "In normal replies, use message=<...>. Plain :name: stays text.",
    ...emojis.map((emoji) => {
      const messageSyntax = formatCustomEmojiMessageSyntax(emoji);
      const reactionSyntax = formatCustomEmojiReactionSyntax(emoji);
      return `- :${emoji.name}: message=\`${messageSyntax}\` reaction=\`${reactionSyntax}\``;
    }),
  ].join("\n");
};

const formatStickerList = async (message: Message<true>): Promise<string> => {
  const stickers = await listUsableStickers(message);
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

const WORKSPACE_ROOT = "/workspace";

const formatToolError = (error: unknown): string => {
  if (error instanceof Error) {
    const parts = [
      error.name.length > 0 ? `${error.name}: ${error.message}` : error.message,
    ].filter((part) => part.length > 0);

    const code = Reflect.get(error, "code");
    if (typeof code === "string" || typeof code === "number") {
      parts.push(`code=${String(code)}`);
    }

    const status = Reflect.get(error, "status");
    if (typeof status === "number" && Number.isFinite(status)) {
      parts.push(`status=${status}`);
    }

    if (error.cause instanceof Error && error.cause.message.length > 0) {
      parts.push(`cause=${error.cause.message}`);
    }

    return parts.join("; ");
  }

  return String(error);
};

const isPathWithinRoot = (rootPath: string, candidatePath: string): boolean => {
  const rel = relative(rootPath, candidatePath);
  return rel !== ".." && !rel.startsWith(`..${"/"}`) && !rel.startsWith(`..${"\\"}`);
};

const resolveWorkspaceFile = async (
  workspaceDir: string,
  inputPath: string,
): Promise<{ hostPath: string; size: number; workspacePath: string } | string> => {
  const rawPath = inputPath.trim();
  if (rawPath.length === 0) {
    return "Path must not be empty.";
  }

  let workspaceRelativePath: string;
  if (rawPath.startsWith(`${WORKSPACE_ROOT}/`)) {
    workspaceRelativePath = rawPath.slice(`${WORKSPACE_ROOT}/`.length);
  } else if (rawPath === WORKSPACE_ROOT) {
    return `${WORKSPACE_ROOT} is a directory. Provide a file path.`;
  } else if (rawPath.startsWith("/")) {
    return `Absolute paths outside ${WORKSPACE_ROOT} are not allowed.`;
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
    return `File ${inputPath} was not found in ${WORKSPACE_ROOT}.`;
  }

  if (!isPathWithinRoot(realWorkspaceRoot, realCandidatePath)) {
    return `Path ${inputPath} resolves outside ${WORKSPACE_ROOT}, which is not allowed.`;
  }

  const fileStat = await stat(realCandidatePath).catch(() => null);
  if (fileStat === null || !fileStat.isFile()) {
    return `Path ${inputPath} is not a regular file.`;
  }

  const normalizedRelative = relative(realWorkspaceRoot, realCandidatePath).replaceAll("\\", "/");
  return {
    hostPath: realCandidatePath,
    size: fileStat.size,
    workspacePath: `${WORKSPACE_ROOT}/${normalizedRelative}`,
  };
};

export interface DiscordToolOptions {
  readonly enableAgenticWorkspace: boolean;
  readonly workspaceDir: string;
}

export const createDiscordTools = (
  originMessage: Message<true>,
  runDiscordAction: <T>(operation: () => Promise<T>) => Promise<T>,
  options: DiscordToolOptions,
): ToolDefinition[] => {
  const tools: ToolDefinition[] = [
    defineTool({
      name: LIST_CUSTOM_EMOJIS_TOOL,
      label: "List Custom Emojis",
      description: "List custom emojis usable here, including exact reply and reaction syntax.",
      promptSnippet: "List custom emojis usable here, including exact reply and reaction syntax",
      promptGuidelines: [
        "For custom emojis in text, use the exact <:name:id> or <a:name:id> syntax from discord_list_custom_emojis. Do not use plain :name:.",
      ],
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: formatEmojiList(originMessage) }],
        details: {},
      }),
    }),
    defineTool({
      name: LIST_STICKERS_TOOL,
      label: "List Stickers",
      description: "List stickers the bot can send here.",
      promptSnippet: "List stickers the bot can send here",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: await formatStickerList(originMessage) }],
        details: {},
      }),
    }),
    defineTool({
      name: SEND_STICKER_TOOL,
      label: "Send Sticker",
      description: "Send one sticker by sticker ID.",
      promptSnippet: "Send one sticker by sticker ID",
      parameters: Type.Object({
        caption: Type.Optional(
          Type.String({
            description: "Optional message text to send with the sticker.",
          }),
        ),
        stickerId: Type.String({ description: "Sticker ID to send." }),
      }),
      execute: async (_toolCallId, params) => {
        const stickers = await listUsableStickers(originMessage);
        const sticker = stickers.find((candidate) => candidate.sticker.id === params.stickerId);

        if (sticker === undefined) {
          return {
            content: [
              {
                type: "text",
                text: `Sticker ${params.stickerId} is not available here.`,
              },
            ],
            details: {},
            isError: true,
          };
        }

        await runDiscordAction(() =>
          originMessage.channel.send({
            content: params.caption,
            stickers: [sticker.sticker.id],
          }),
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
      description: "Add one reaction to a message in the current Discord channel.",
      promptSnippet: "Add a reaction to a message in the current Discord channel",
      promptGuidelines: [
        "Use discord_react with a message ID from the conversation transcript. For custom emoji reactions, use the reaction syntax from discord_list_custom_emojis.",
      ],
      parameters: Type.Object({
        emoji: Type.String({ description: "Emoji reaction to add." }),
        messageId: Type.String({ description: "Discord message ID in the current channel." }),
      }),
      execute: async (_toolCallId, params) => {
        if (
          !("messages" in originMessage.channel) ||
          typeof originMessage.channel.messages.fetch !== "function"
        ) {
          return {
            content: [
              {
                type: "text",
                text: "This Discord channel does not support fetching messages for reactions.",
              },
            ],
            details: {},
            isError: true,
          };
        }

        const targetMessage = await originMessage.channel.messages
          .fetch(params.messageId)
          .catch(() => null);
        if (targetMessage === null) {
          return {
            content: [
              {
                type: "text",
                text: `Message ${params.messageId} was not found in the current channel.`,
              },
            ],
            details: {},
            isError: true,
          };
        }

        const emoji = normalizeReactionEmoji(originMessage, params.emoji);
        if (emoji === null) {
          return {
            content: [
              {
                type: "text",
                text: "That emoji is invalid or not available here.",
              },
            ],
            details: {},
            isError: true,
          };
        }

        await runDiscordAction(() => targetMessage.react(emoji));

        return {
          content: [
            {
              type: "text",
              text: `Added reaction ${emoji} to message ${targetMessage.id}.`,
            },
          ],
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
        description: "Upload one file from /workspace to the current Discord channel.",
        promptSnippet: "Upload a file from /workspace to the current Discord channel",
        promptGuidelines: [
          "Use discord_upload_file when the user asks for a file/download/attachment.",
          "Only provide paths inside /workspace.",
          "If needed, use read/bash tools first to inspect or generate the file in /workspace.",
        ],
        parameters: Type.Object({
          caption: Type.Optional(
            Type.String({
              description: "Optional message text to send with the uploaded file.",
            }),
          ),
          fileName: Type.Optional(
            Type.String({ description: "Optional attachment file name override." }),
          ),
          path: Type.String({
            description: `Path to a file in ${WORKSPACE_ROOT} (absolute or relative to ${WORKSPACE_ROOT}).`,
          }),
        }),
        execute: async (_toolCallId, params) => {
          const resolved = await resolveWorkspaceFile(options.workspaceDir, params.path);
          if (typeof resolved === "string") {
            return {
              content: [{ type: "text", text: resolved }],
              details: {},
              isError: true,
            };
          }

          const fileName = params.fileName?.trim() || basename(resolved.hostPath);
          const failures: string[] = [];
          let sent = false;

          try {
            await runDiscordAction(() =>
              originMessage.channel.send({
                content: params.caption,
                files: [{ attachment: resolved.hostPath, name: fileName }],
              }),
            );
            sent = true;
          } catch (error) {
            failures.push(`path attempt failed: ${formatToolError(error)}`);

            const attachmentBuffer = await readFile(resolved.hostPath).catch(() => null);
            if (attachmentBuffer === null) {
              failures.push(`buffer attempt skipped: failed to read ${resolved.workspacePath}`);
            } else {
              try {
                await runDiscordAction(() =>
                  originMessage.channel.send({
                    content: params.caption,
                    files: [{ attachment: attachmentBuffer, name: fileName }],
                  }),
                );
                sent = true;
              } catch (bufferError) {
                failures.push(`buffer attempt failed: ${formatToolError(bufferError)}`);
              }
            }
          }

          if (!sent) {
            return {
              content: [
                {
                  type: "text",
                  text: `Discord rejected file upload ${fileName}. ${failures.join(" | ")}`,
                },
              ],
              details: {},
              isError: true,
            };
          }

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
