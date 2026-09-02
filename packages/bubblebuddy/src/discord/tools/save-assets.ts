import { Constants, FormattingPatterns, StickerFormatType, parseEmoji } from "discord.js";
import { Effect } from "effect";
import { Type } from "typebox";

import { DISCORD_ASSETS_SEGMENT } from "../../shared/constants.ts";
import { sanitizeAttachmentFilename } from "../../shared/workspace.ts";
import { defineEffectTool } from "../../pi/effect-tool.ts";
import { listUsableStickers, type UsableSticker } from "../assets.ts";
import { ChannelWorkspace, DiscordToolContext } from "../tool-context.ts";
import { AssetSaveError, downloadAsset, runAssetJobs } from "./asset-save.ts";

const saveCustomEmojiAsset = Effect.fn("saveCustomEmojiAsset")(function* (input: string) {
  const emoji = yield* Effect.try({
    try: () => parseEmoji(input),
    catch: () => new AssetSaveError({ message: `Invalid custom emoji syntax: ${input}` }),
  });
  if (emoji?.id === undefined)
    return yield* new AssetSaveError({ message: `Invalid custom emoji syntax: ${input}` });

  const context = yield* DiscordToolContext;
  const workspace = yield* ChannelWorkspace;
  const extension = emoji.animated ? "gif" : "png";
  const directory = yield* workspace.ensureDirectory(DISCORD_ASSETS_SEGMENT, "emojis", emoji.id);
  return yield* downloadAsset(
    context.channel.client.rest.cdn.emoji(emoji.id, { extension }),
    directory,
    `${emoji.name}.${extension}`,
  );
});

const createStickerJobs = Effect.fn("createStickerJobs")(function* (ids: readonly string[]) {
  if (ids.length === 0) return [];
  const context = yield* DiscordToolContext;
  return yield* listUsableStickers(context).pipe(
    Effect.match({
      onFailure: (error) =>
        ids.map((_, index) => ({
          label: `sticker ${index}`,
          save: Effect.fail(new AssetSaveError({ message: error.message })),
        })),
      onSuccess: (stickers) =>
        ids.map((id, index) => ({
          label: `sticker ${index}`,
          save: saveStickerAsset(id, stickers),
        })),
    }),
  );
});

const saveStickerAsset = Effect.fn("saveStickerAsset")(function* (
  id: string,
  stickers: readonly UsableSticker[],
) {
  const sticker = stickers.find((entry) => entry.sticker.id === id)?.sticker;
  if (sticker === undefined) return yield* new AssetSaveError({ message: "Sticker not found." });
  if (sticker.format === StickerFormatType.Lottie) {
    return yield* new AssetSaveError({ message: "Lottie stickers are not supported." });
  }

  const workspace = yield* ChannelWorkspace;
  const extension = Constants.StickerFormatExtensionMap[sticker.format];
  const directory = yield* workspace.ensureDirectory(
    DISCORD_ASSETS_SEGMENT,
    "stickers",
    sticker.id,
  );
  return yield* downloadAsset(
    sticker.url,
    directory,
    `${sanitizeAttachmentFilename(sticker.name)}.${extension}`,
  );
});

export const saveAssetsTool = defineEffectTool({
  name: "discord_save_assets",
  label: "Save Discord Assets",
  description: "Save custom emojis and stickers into /workspace.",
  promptSnippet: "Save custom emojis and stickers into /workspace",
  parameters: Type.Object({
    customEmojis: Type.Optional(
      Type.Array(
        Type.String({
          description: "Exact syntax such as <:wave:123> or <a:dance:456>",
          pattern: FormattingPatterns.Emoji,
        }),
        {
          minItems: 1,
          uniqueItems: true,
        },
      ),
    ),
    stickers: Type.Optional(
      Type.Array(Type.String({ description: "Sticker ID" }), { minItems: 1, uniqueItems: true }),
    ),
  }),
  execute: (_toolCallId, params) =>
    Effect.gen(function* () {
      const customEmojis = params.customEmojis ?? [];
      const emojiJobs = customEmojis.map((syntax, index) => ({
        label: `emoji ${index}`,
        save: saveCustomEmojiAsset(syntax),
      }));

      const stickerJobs = yield* createStickerJobs(params.stickers ?? []);

      const text = yield* runAssetJobs([...emojiJobs, ...stickerJobs]);
      return { content: [{ type: "text", text }], details: undefined };
    }),
});
