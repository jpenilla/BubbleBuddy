import { type Message } from "discord.js";
import { Effect } from "effect";
import { GuestPath } from "incus-api";
import { Type } from "typebox";

import { defineEffectTool } from "../../pi/effect-tool.ts";
import { DISCORD_ASSETS_SEGMENT } from "../../shared/constants.ts";
import { collectMessageAssets } from "../message-assets.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import {
  AssetSaveError,
  downloadAsset,
  downloadAssetByContentType,
  prepareAssetDirectory,
  runAssetJobs,
} from "./asset-save.ts";

const saveMessageAssets = Effect.fn("saveMessageAssets")(function* (
  message: Message<true>,
  selections: { readonly assets: readonly string[] },
) {
  const guestPath = yield* GuestPath.Service;
  const directory = guestPath.path.join(DISCORD_ASSETS_SEGMENT, message.id);
  const catalog = new Map(collectMessageAssets(message).catalog.map((asset) => [asset.key, asset]));
  const jobs = [];
  for (const key of selections.assets) {
    const asset = catalog.get(key);
    if (asset === undefined)
      return yield* new AssetSaveError({ message: `Unknown asset key: ${key}.` });
    const destination = guestPath.path.join(
      directory,
      ...(asset.forwarded ? ["forwarded"] : []),
      key,
    );
    jobs.push({
      label: key,
      save: Effect.gen(function* () {
        if (asset.url === undefined)
          return yield* new AssetSaveError({ message: "Asset has no downloadable URL." });
        const folder = yield* prepareAssetDirectory(destination);
        return asset.attachment
          ? yield* downloadAsset(asset.url, folder, asset.filename)
          : yield* downloadAssetByContentType(asset.url, folder, asset.filename);
      }),
    });
  }
  // Prepare shared directories before these jobs run concurrently; separate calls can still race on .discord-assets.
  yield* prepareAssetDirectory(directory);
  if (selections.assets.some((key) => catalog.get(key)?.forwarded)) {
    yield* prepareAssetDirectory(directory, "forwarded");
  }
  return yield* runAssetJobs(jobs);
});

export const saveMessageAssetsTool = defineEffectTool({
  name: "discord_save_message_assets",
  label: "Save Message Assets",
  description:
    "Save message attachments, embed media, and component media into the container workspace using the asset keys shown in the message. Asset keys and media metadata do not show the media itself; save an asset and open the saved file in the workspace to inspect it.",
  parameters: Type.Object({
    messageId: Type.String({ description: "Message ID" }),
    assets: Type.Array(Type.String({ pattern: "^a[1-9][0-9]*$" }), {
      minItems: 1,
      uniqueItems: true,
    }),
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
