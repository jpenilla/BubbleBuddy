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
    return "No custom emojis are available here.";
  }

  return [
    "Custom emojis you can use here:",
    "In normal replies, use message=<...>. Plain :name: stays text.",
    ...emojis.map((emoji) => {
      const messageSyntax = formatCustomEmoji(emoji);
      const reactionSyntax = `${emoji.animated ? "a:" : ""}${emoji.name}:${emoji.id}`;
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

export const createDiscordTools = (originMessage: Message<true>): ToolDefinition[] => [
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
