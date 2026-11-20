import { obj } from "@earendil-works/pi-schema";
import { formatEmoji } from "discord.js";
import { Effect } from "effect";

import { defineEffectTool } from "../../pi/effect-tool.ts";
import { listUsableCustomEmojis } from "../assets.ts";
import { DiscordToolContext } from "../tool-context.ts";

export const listCustomEmojisTool = defineEffectTool({
  name: "discord_list_custom_emojis",
  description: "List custom emojis usable here.",
  parameters: obj({}),
  replay: "safe",
  execute: () =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const emojis = listUsableCustomEmojis(context);
      if (emojis.length === 0)
        return {
          output: [{ type: "text", text: "No custom emojis are available here." }],
        };
      return {
        output: [
          {
            type: "text",
            text: [
              "Custom emojis (use exactly as shown):",
              ...emojis.map((emoji) => `- \`${formatEmoji(emoji)}\``),
            ].join("\n"),
          },
        ],
      };
    }),
});
