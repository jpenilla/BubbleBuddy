import type { Message } from "discord.js";
import { Effect } from "effect";
import { Type } from "typebox";

import { DISCORD_ASSETS_SEGMENT } from "../../shared/constants.ts";
import { sanitizeAttachmentFilename } from "../../shared/workspace.ts";
import { defineEffectTool } from "../../pi/effect-tool.ts";
import { ChannelWorkspace, DiscordToolContext } from "../tool-context.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import {
  AssetSaveError,
  downloadAsset,
  downloadAssetByContentType,
  runAssetJobs,
} from "./asset-save.ts";

type EmbedAssetSlot = "author-icon" | "footer-icon" | "image" | "thumbnail" | "video";

const embedAssetUrl = (
  embed: Message<true>["embeds"][number],
  slot: EmbedAssetSlot,
): string | undefined => {
  switch (slot) {
    case "image":
    case "thumbnail":
    case "video":
      return embed[slot]?.proxyURL;
    case "author-icon":
      return embed.author?.proxyIconURL;
    case "footer-icon":
      return embed.footer?.proxyIconURL;
  }
};

const saveMessageAttachment = Effect.fn("saveMessageAttachment")(function* (
  message: Message<true>,
  index: number,
) {
  const attachment = [...message.attachments.values()][index];
  if (attachment === undefined)
    return yield* new AssetSaveError({ message: "Attachment not found." });
  const workspace = yield* ChannelWorkspace;
  const directory = yield* workspace.ensureDirectory(
    DISCORD_ASSETS_SEGMENT,
    message.id,
    "attachments",
    String(index),
  );
  return yield* downloadAsset(
    attachment.url,
    directory,
    sanitizeAttachmentFilename(attachment.name),
  );
});

const saveEmbedAsset = Effect.fn("saveEmbedAsset")(function* (
  message: Message<true>,
  index: number,
  slot: EmbedAssetSlot,
) {
  const embed = message.embeds[index];
  if (embed === undefined) return yield* new AssetSaveError({ message: "Embed not found." });
  const url = embedAssetUrl(embed, slot);
  if (!url) return yield* new AssetSaveError({ message: `Embed has no downloadable ${slot}.` });
  const workspace = yield* ChannelWorkspace;
  const directory = yield* workspace.ensureDirectory(
    DISCORD_ASSETS_SEGMENT,
    message.id,
    "embeds",
    String(index),
  );
  return yield* downloadAssetByContentType(url, directory, slot);
});

const saveMessageAssets = Effect.fn("saveMessageAssets")(function* (
  message: Message<true>,
  selections: {
    readonly attachments?: readonly number[];
    readonly embedAuthorIcons?: readonly number[];
    readonly embedFooterIcons?: readonly number[];
    readonly embedImages?: readonly number[];
    readonly embedThumbnails?: readonly number[];
    readonly embedVideos?: readonly number[];
  },
) {
  const attachmentJobs = (selections.attachments ?? []).map((index) => ({
    label: `attachment ${index}`,
    save: saveMessageAttachment(message, index),
  }));
  const embedJobs = (indices: readonly number[] | undefined, slot: EmbedAssetSlot) =>
    (indices ?? []).map((index) => ({
      label: `embed ${index} ${slot}`,
      save: saveEmbedAsset(message, index, slot),
    }));

  return yield* runAssetJobs([
    ...attachmentJobs,
    ...embedJobs(selections.embedImages, "image"),
    ...embedJobs(selections.embedThumbnails, "thumbnail"),
    ...embedJobs(selections.embedVideos, "video"),
    ...embedJobs(selections.embedAuthorIcons, "author-icon"),
    ...embedJobs(selections.embedFooterIcons, "footer-icon"),
  ]);
});

const Indices = Type.Array(Type.Integer({ minimum: 0 }), {
  minItems: 1,
  uniqueItems: true,
});

export const saveMessageAssetsTool = defineEffectTool({
  name: "discord_save_message_assets",
  label: "Save Message Assets",
  description:
    "Save explicitly selected message attachments and embed media slots into /workspace.",
  promptSnippet:
    "Save explicitly selected Discord message attachments and embed media into /workspace",
  parameters: Type.Object({
    messageId: Type.String({ description: "Message ID" }),
    attachments: Type.Optional(Indices),
    embedAuthorIcons: Type.Optional(Indices),
    embedFooterIcons: Type.Optional(Indices),
    embedImages: Type.Optional(Indices),
    embedThumbnails: Type.Optional(Indices),
    embedVideos: Type.Optional(Indices),
  }),
  execute: (_toolCallId, params) =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const message = yield* tryDiscordJsPromise(() =>
        context.channel.messages.fetch(params.messageId),
      );
      const text = yield* saveMessageAssets(message, params);
      return { content: [{ type: "text", text }], details: undefined };
    }),
});
