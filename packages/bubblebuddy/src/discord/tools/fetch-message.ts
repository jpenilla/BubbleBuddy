import { Effect } from "effect";
import { Type } from "typebox";

import { defineEffectTool } from "../../pi/effect-tool.ts";
import { formatMessageForPrompt } from "../prompt-formatting.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { tryDiscordJsPromise } from "../utils.ts";

export const fetchMessageTool = defineEffectTool({
  name: "discord_fetch_message",
  description: "Fetch a message in the current Discord channel.",
  parameters: Type.Object({
    messageId: Type.String({ description: "Message ID" }),
  }),
  replay: "safe",
  execute: (params) =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const message = yield* tryDiscordJsPromise(() =>
        context.channel.messages.fetch(params.messageId),
      );
      return {
        content: [{ type: "text", text: formatMessageForPrompt(message) }],
      };
    }),
});
