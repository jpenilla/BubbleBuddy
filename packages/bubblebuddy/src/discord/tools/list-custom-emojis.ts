import { Effect } from "effect";
import { Type } from "typebox";
import { formatEmoji } from "discord.js";

import { listUsableCustomEmojis } from "../assets.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { defineEffectTool } from "../../pi/effect-tool.ts";

export const listCustomEmojisTool = defineEffectTool({
  name: "discord_list_custom_emojis",
  label: "List Custom Emojis",
  description: "List custom emojis usable here.",
  promptSnippet: "List custom emojis usable here",
  parameters: Type.Object({}),
  execute: () =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const emojis = listUsableCustomEmojis(context);
      if (emojis.length === 0)
        return {
          content: [{ type: "text", text: "No custom emojis are available here." }],
          details: undefined,
        };
      return {
        content: [
          {
            type: "text",
            text: [
              "Custom emojis (use exactly as shown):",
              ...emojis.map((emoji) => `- \`${formatEmoji(emoji)}\``),
            ].join("\n"),
          },
        ],
        details: undefined,
      };
    }),
});
