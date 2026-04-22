import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Message } from "discord.js";

import { formatCustomEmoji, listUsableCustomEmojis, listUsableStickers } from "./assets.ts";

const LIST_CUSTOM_EMOJIS_TOOL = "discord_list_custom_emojis";
const LIST_STICKERS_TOOL = "discord_list_stickers";
const SEND_STICKER_TOOL = "discord_send_sticker";

const formatEmojiList = (message: Message<true>): string => {
  const emojis = listUsableCustomEmojis(message);
  if (emojis.length === 0) {
    return "No custom emojis are available in this Discord context.";
  }

  return [
    "Custom emojis available in this Discord context:",
    ...emojis.map(
      (emoji) =>
        `- ${formatCustomEmoji(emoji)} :${emoji.name}: id=${emoji.id} guild=${emoji.guild.name}`,
    ),
  ].join("\n");
};

const formatStickerList = async (message: Message<true>): Promise<string> => {
  const stickers = await listUsableStickers(message);
  if (stickers.length === 0) {
    return "No stickers are available in this Discord context.";
  }

  return [
    "Stickers available in this Discord context:",
    ...stickers.map(({ guildName, packName, sticker }) => {
      const source = guildName !== null ? `guild=${guildName}` : `pack=${packName ?? "unknown"}`;
      const tags = sticker.tags ? ` tags=${sticker.tags}` : "";
      return `- id=${sticker.id} name=${sticker.name} ${source}${tags}`;
    }),
  ].join("\n");
};

export const createDiscordTools = (originMessage: Message<true>): ToolDefinition[] => [
  defineTool({
    name: LIST_CUSTOM_EMOJIS_TOOL,
    label: "List Custom Emojis",
    description: "List the custom emojis the bot can use in the current Discord context.",
    promptSnippet: "List the custom emojis available in the current Discord context",
    promptGuidelines: [
      "Use discord_list_custom_emojis when you need a valid custom emoji or emoji ID for this Discord server.",
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
    description: "List the stickers the bot can send in the current Discord context.",
    promptSnippet: "List the stickers available in the current Discord context",
    promptGuidelines: [
      "Use discord_list_stickers before discord_send_sticker when you need to discover valid sticker IDs.",
    ],
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: await formatStickerList(originMessage) }],
      details: {},
    }),
  }),
  defineTool({
    name: SEND_STICKER_TOOL,
    label: "Send Sticker",
    description: "Send a sticker that is available in the current Discord context by sticker ID.",
    promptSnippet: "Send a sticker by sticker ID in the current Discord channel",
    promptGuidelines: [
      "Use discord_send_sticker only with sticker IDs that are valid in the current Discord context, usually after calling discord_list_stickers.",
    ],
    parameters: Type.Object({
      caption: Type.Optional(
        Type.String({ description: "Optional message text to send with the sticker." }),
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
              text: `Sticker ${params.stickerId} is not available in this Discord context.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      await originMessage.channel.send({
        content: params.caption,
        stickers: [sticker.sticker.id],
      });

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
];
