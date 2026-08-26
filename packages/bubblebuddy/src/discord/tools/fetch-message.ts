import { Effect } from "effect";
import { Type } from "typebox";

import { formatMessageForPrompt } from "../prompt-formatting.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { defineEffectTool } from "../../tools/effect-tool.ts";

export const fetchMessageTool = defineEffectTool({
  name: "discord_fetch_message",
  label: "Fetch Message",
  description: "Fetch a message in the current Discord channel.",
  promptSnippet: "Fetch a message in the current Discord channel",
  promptGuidelines: [
    "When a message replies to or otherwise references a message ID you do not recognize, you may attempt to fetch it",
  ],
  parameters: Type.Object({
    messageId: Type.String({ description: "Message ID" }),
  }),
  execute: (_toolCallId, params) =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const message = yield* tryDiscordJsPromise(() =>
        context.channel.messages.fetch(params.messageId),
      );
      return {
        content: [{ type: "text", text: formatMessageForPrompt(message) }],
        details: undefined,
      };
    }),
});
