import type { Attachment, Embed, Message } from "discord.js";
import { Effect } from "effect";
import { posix } from "node:path";
import { Type } from "typebox";

import { DISCORD_ASSETS_SEGMENT } from "../../shared/constants.ts";
import { sanitizeAttachmentFilename } from "../../shared/workspace.ts";
import { defineEffectTool } from "../../pi/effect-tool.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import {
  AssetSaveError,
  downloadAsset,
  downloadAssetByContentType,
  prepareAssetDirectory,
  runAssetJobs,
} from "./asset-save.ts";

type EmbedAssetSlot = "author-icon" | "footer-icon" | "image" | "thumbnail" | "video";
type AssetSource = "message" | "forwarded";

const embedAssetUrl = (embed: Embed, slot: EmbedAssetSlot): string | undefined => {
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
  attachment: Attachment | undefined,
  destination: string,
) {
  if (attachment === undefined)
    return yield* new AssetSaveError({ message: "Attachment not found." });
  const directory = yield* prepareAssetDirectory(destination);
  return yield* downloadAsset(
    attachment.url,
    directory,
    sanitizeAttachmentFilename(attachment.name),
  );
});

const saveEmbedAsset = Effect.fn("saveEmbedAsset")(function* (
  embed: Embed | undefined,
  destination: string,
  slot: EmbedAssetSlot,
) {
  if (embed === undefined) return yield* new AssetSaveError({ message: "Embed not found." });
  const url = embedAssetUrl(embed, slot);
  if (!url) return yield* new AssetSaveError({ message: `Embed has no downloadable ${slot}.` });
  const directory = yield* prepareAssetDirectory(destination);
  return yield* downloadAssetByContentType(url, directory, slot);
});

const saveMessageAssets = Effect.fn("saveMessageAssets")(function* (
  message: Message<true>,
  selections: {
    readonly source?: AssetSource;
    readonly attachments?: readonly number[];
    readonly embedAuthorIcons?: readonly number[];
    readonly embedFooterIcons?: readonly number[];
    readonly embedImages?: readonly number[];
    readonly embedThumbnails?: readonly number[];
    readonly embedVideos?: readonly number[];
  },
) {
  const source = selections.source ?? "message";
  const assets = source === "forwarded" ? message.messageSnapshots.first() : message;
  if (assets === undefined) {
    return yield* new AssetSaveError({ message: "Forwarded message snapshot not found." });
  }
  const directory = posix.join(
    DISCORD_ASSETS_SEGMENT,
    message.id,
    source === "forwarded" ? "forwarded" : "",
  );
  const attachments = [...assets.attachments.values()];
  const attachmentJobs = (selections.attachments ?? []).map((index) => ({
    label: `attachment ${index}`,
    save: saveMessageAttachment(
      attachments[index],
      posix.join(directory, "attachments", String(index)),
    ),
  }));
  const embedJobs = (indices: readonly number[] | undefined, slot: EmbedAssetSlot) =>
    (indices ?? []).map((index) => ({
      label: `embed ${index} ${slot}`,
      save: saveEmbedAsset(
        assets.embeds[index],
        posix.join(directory, "embeds", String(index)),
        slot,
      ),
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
  description: "Save message attachments and embed media into the container workspace.",
  parameters: Type.Object({
    messageId: Type.String({ description: "Message ID" }),
    source: Type.Optional(
      Type.Union([Type.Literal("message"), Type.Literal("forwarded")], {
        description:
          "Use forwarded for attachments and embeds inside the [forwarded] block; otherwise message (default).",
      }),
    ),
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
