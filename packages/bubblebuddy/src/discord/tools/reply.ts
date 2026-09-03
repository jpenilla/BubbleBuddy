import { Effect } from "effect";
import { Type } from "typebox";

import { DiscordToolContext } from "../tool-context.ts";
import { sendChunkedMessage } from "../utils.ts";
import { defineEffectTool } from "../../pi/effect-tool.ts";

export const replyTool = defineEffectTool({
  name: "discord_reply",
  label: "Reply",
  description: "Reply to a message in the current channel, optionally ending the turn.",
  promptSnippet: "Reply to a message in the current channel, optionally ending the turn",
  promptGuidelines: [
    "Ordinary assistant text is posted without replying. Use an explicit mention or discord_reply when a user should be notified.",
    "Call discord_reply with terminate=true as the only tool call when its content is the complete final response and no further work is needed.",
  ],
  parameters: Type.Object({
    messageId: Type.String({ description: "ID of the message to reply to" }),
    content: Type.String({ minLength: 1, description: "Reply content" }),
    ping: Type.Boolean({
      description:
        "Notify the author through the reply itself; explicit content mentions are unaffected",
    }),
    terminate: Type.Optional(
      Type.Boolean({ description: "End the turn after sending this reply" }),
    ),
  }),
  execute: (_toolCallId, params) =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      yield* context.executeOrdered(
        sendChunkedMessage({
          channel: context.channel,
          content: params.content,
          reply: {
            messageReference: params.messageId,
            failIfNotExists: true,
          },
          allowedMentions: params.ping
            ? undefined
            : { parse: ["users", "roles", "everyone"], repliedUser: false },
        }),
      );

      return {
        content: [{ type: "text", text: `Replied to message ${params.messageId}.` }],
        details: undefined,
        terminate: params.terminate,
      };
    }),
});
