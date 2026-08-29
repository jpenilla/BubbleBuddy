import { Effect } from "effect";
import { Type } from "typebox";

import { listUsableStickers } from "../assets.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { defineEffectTool } from "../../pi/effect-tool.ts";

export const listStickersTool = defineEffectTool({
  name: "discord_list_stickers",
  label: "List Stickers",
  description: "List stickers usable here.",
  promptSnippet: "List stickers usable here",
  parameters: Type.Object({}),
  execute: () =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const stickers = yield* tryDiscordJsPromise(() => listUsableStickers(context));
      if (stickers.length === 0)
        return {
          content: [{ type: "text", text: "No stickers are available here." }],
          details: undefined,
        };
      return {
        content: [
          {
            type: "text",
            text: [
              "Stickers you can send here:",
              ...stickers.map(({ guildName, packName, sticker }) => {
                const source =
                  guildName !== null ? `guild=${guildName}` : `pack=${packName ?? "unknown"}`;
                const tags = sticker.tags ? ` tags=${sticker.tags}` : "";
                return `- id=${sticker.id} name=${sticker.name} ${source}${tags}`;
              }),
            ].join("\n"),
          },
        ],
        details: undefined,
      };
    }),
});
