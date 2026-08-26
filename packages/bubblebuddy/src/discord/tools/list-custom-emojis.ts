import { Effect } from "effect";
import { Type } from "typebox";

import {
  formatCustomEmojiMessageSyntax,
  formatCustomEmojiReactionSyntax,
  listUsableCustomEmojis,
} from "../assets.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { defineEffectTool } from "../../tools/effect-tool.ts";

const NAME = "discord_list_custom_emojis";

export const listCustomEmojisTool = Effect.fn("listCustomEmojisTool")(function* () {
  const context = yield* DiscordToolContext;

  return defineEffectTool({
    name: NAME,
    label: "List Custom Emojis",
    description: "List custom emojis usable here, including exact text and reaction syntax.",
    promptSnippet: "List custom emojis usable here, including exact text and reaction syntax",
    promptGuidelines: [
      `For custom emojis, always use exact syntax from ${NAME} in text and reactions.`,
    ],
    parameters: Type.Object({}),
    execute: () =>
      Effect.sync(() => {
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
                "Custom emojis you can use here:",
                ...emojis.map((emoji) => {
                  const messageSyntax = formatCustomEmojiMessageSyntax(emoji);
                  const reactionSyntax = formatCustomEmojiReactionSyntax(emoji);
                  return `- :${emoji.name}: message=\`${messageSyntax}\` reaction=\`${reactionSyntax}\``;
                }),
                "Always use the exact correct syntax for the use case. Do not escape or show the plain name unless a task explicitly needs it or a user asks.",
              ].join("\n"),
            },
          ],
          details: undefined,
        };
      }),
  });
});
