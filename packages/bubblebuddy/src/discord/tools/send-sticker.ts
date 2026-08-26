import { Effect } from "effect";
import { Type } from "typebox";

import { listUsableStickers } from "../assets.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { AgentToolError, defineEffectTool } from "../../tools/effect-tool.ts";

export const sendStickerTool = Effect.fn("sendStickerTool")(function* () {
  const context = yield* DiscordToolContext;

  return defineEffectTool({
    name: "discord_send_sticker",
    label: "Send Sticker",
    description: "Send one sticker.",
    promptSnippet: "Send one sticker",
    parameters: Type.Object({
      caption: Type.Optional(
        Type.String({ description: "Optional message text to send with the sticker" }),
      ),
      stickerId: Type.String({ description: "Sticker ID" }),
    }),
    execute: (_toolCallId, params) =>
      Effect.gen(function* () {
        const stickers = yield* tryDiscordJsPromise(() => listUsableStickers(context));
        const sticker = stickers.find((candidate) => candidate.sticker.id === params.stickerId);
        if (sticker === undefined)
          return yield* new AgentToolError({
            message: `Sticker ${params.stickerId} is not available here.`,
          });

        yield* context.awaitAction(
          tryDiscordJsPromise(() =>
            context.channel.send({ content: params.caption, stickers: [sticker.sticker.id] }),
          ),
        );

        return {
          content: [
            { type: "text", text: `Sent sticker ${sticker.sticker.name} (${sticker.sticker.id}).` },
          ],
          details: undefined,
        };
      }),
  });
});
