import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  Collection,
  StickerFormatType,
  StickerType,
  type GuildTextBasedChannel,
  type Message,
  type Sticker,
} from "discord.js";
import { Effect, FileSystem, Path } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ChannelWorkspace, DiscordToolContext } from "../src/discord/tool-context.ts";
import { saveAssetsTool } from "../src/discord/tools/save-assets.ts";
import { saveMessageAssetsTool } from "../src/discord/tools/save-message-assets.ts";
import { WORKSPACE_CWD } from "../src/shared/constants.ts";
import { createMountedWorkspace } from "../src/shared/workspace.ts";

const extensionContext = {} as ExtensionContext;

const makeHttpClient = (
  requestedUrls: string[],
  responseForUrl: (url: string) => Response,
): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    requestedUrls.push(request.url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, responseForUrl(request.url)));
  });

const createTool = <R>(
  tool: Effect.Effect<ToolDefinition, never, R>,
  channel: GuildTextBasedChannel,
  workspaceDir: string,
  httpClient: HttpClient.HttpClient,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* tool.pipe(
      Effect.provideService(
        ChannelWorkspace,
        ChannelWorkspace.of(createMountedWorkspace(path, workspaceDir, WORKSPACE_CWD)),
      ),
      Effect.provideService(
        DiscordToolContext,
        DiscordToolContext.of({ channel, executeOrdered: (operation) => operation }),
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
  });

const execute = (tool: ToolDefinition, params: Record<string, unknown>) =>
  Effect.promise(() => tool.execute("tool-call", params, undefined, undefined, extensionContext));

const createWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "bubblebuddy-discord-assets-" });
});

it.layer(NodeServices.layer)("Discord asset tools", (it) => {
  it.effect("fetches a message once and continues after failed message-asset selections", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* createWorkspace;
      const requestedUrls: string[] = [];
      const http = makeHttpClient(requestedUrls, (url) => {
        if (url.endsWith("missing")) return new Response(new Uint8Array([1]));
        if (url.endsWith("text"))
          return new Response("text", { headers: { "content-type": "text/plain" } });
        if (url.endsWith("unknown"))
          return new Response("image", { headers: { "content-type": "image/x-unknown" } });
        return new Response("image bytes", { headers: { "content-type": "image/png" } });
      });
      let fetchCount = 0;
      const message = {
        id: "message-1",
        attachments: new Collection([
          ["a", { name: "photo.png", url: "https://cdn.test/photo.png" }],
        ]),
        embeds: [
          {
            image: {
              url: "https://origin.test/image",
              proxyURL: "https://proxy.test/image",
            },
            thumbnail: null,
            video: { url: "unused", proxyURL: "https://proxy.test/video" },
            author: {
              iconURL: "unused",
              proxyIconURL: "https://proxy.test/author-icon",
            },
            footer: {
              iconURL: "unused",
              proxyIconURL: "https://proxy.test/footer-icon",
            },
          },
          { image: { url: "unused", proxyURL: "https://proxy.test/missing" } },
          { image: { url: "unused", proxyURL: "https://proxy.test/text" } },
          { image: { url: "unused", proxyURL: "https://proxy.test/unknown" } },
        ],
      } as unknown as Message<true>;
      const channel = {
        messages: {
          fetch: async () => {
            fetchCount += 1;
            return message;
          },
        },
      } as unknown as GuildTextBasedChannel;
      const tool = yield* createTool(saveMessageAssetsTool, channel, workspace, http);
      const result = yield* execute(tool, {
        messageId: "message-1",
        attachments: [0, 8],
        embedImages: [0, 1, 2, 3],
        embedThumbnails: [0],
        embedVideos: [0],
        embedAuthorIcons: [0],
        embedFooterIcons: [0],
      });

      expect(fetchCount).toBe(1);
      expect(requestedUrls).toContain("https://proxy.test/image");
      expect(requestedUrls).not.toContain("https://origin.test/image");
      const output = (result.content[0] as { readonly text: string }).text;
      for (const expected of [
        "/workspace/.discord-assets/message-1/attachments/0/photo.png",
        "[attachment 8] error: Attachment not found.",
        "/workspace/.discord-assets/message-1/embeds/0/image.png",
        "Asset response has no Content-Type.",
        "/workspace/.discord-assets/message-1/embeds/2/image.txt",
        "Asset has an unknown Content-Type: image/x-unknown.",
        "Embed has no downloadable thumbnail.",
        "/workspace/.discord-assets/message-1/embeds/0/video.png",
        "/workspace/.discord-assets/message-1/embeds/0/author-icon.png",
        "/workspace/.discord-assets/message-1/embeds/0/footer-icon.png",
      ]) {
        expect(output).toContain(expected);
      }
      expect(
        yield* fs.readFileString(
          path.join(workspace, ".discord-assets/message-1/attachments/0/photo.png"),
        ),
      ).toBe("image bytes");
      expect(
        yield* fs.readFileString(
          path.join(workspace, ".discord-assets/message-1/embeds/0/image.png"),
        ),
      ).toBe("image bytes");
    }),
  );

  it.effect("downloads exact custom emoji syntax and supported channel-scoped stickers", () =>
    Effect.gen(function* () {
      const workspace = yield* createWorkspace;
      const requestedUrls: string[] = [];
      const http = makeHttpClient(requestedUrls, () => new Response("asset bytes"));
      const stickers = new Collection<string, Sticker>([
        [
          "200",
          {
            id: "200",
            name: "party",
            format: StickerFormatType.APNG,
            type: StickerType.Guild,
            guildId: "guild-1",
            available: true,
            url: "https://cdn.test/sticker.png",
          } as Sticker,
        ],
        [
          "201",
          {
            id: "201",
            name: "motion",
            format: StickerFormatType.Lottie,
            type: StickerType.Guild,
            guildId: "guild-1",
            available: true,
            url: "https://cdn.test/sticker.json",
          } as Sticker,
        ],
      ]);
      const guild = {
        id: "guild-1",
        name: "Guild",
        stickers: { cache: stickers },
      };
      const channel = {
        guild,
        permissionsFor: () => ({ has: () => false }),
        client: {
          user: { id: "bot" },
          guilds: { cache: new Collection([[guild.id, guild]]) },
          rest: {
            cdn: {
              emoji: (id: string, options: { readonly extension: string }) =>
                `https://cdn.discordapp.com/emojis/${id}.${options.extension}`,
            },
          },
          fetchStickerPacks: async () => new Collection(),
        },
      } as unknown as GuildTextBasedChannel;
      const tool = yield* createTool(saveAssetsTool, channel, workspace, http);
      const result = yield* execute(tool, {
        customEmojis: ["<a:wave:12345678901234567>", "wave:bad"],
        stickers: ["200", "201"],
      });

      expect(requestedUrls).toContain("https://cdn.discordapp.com/emojis/12345678901234567.gif");
      expect(requestedUrls).toContain("https://cdn.test/sticker.png");
      const output = (result.content[0] as { readonly text: string }).text;
      expect(output).toContain("/workspace/.discord-assets/emojis/12345678901234567/wave.gif");
      expect(output).toContain("Invalid custom emoji syntax: wave:bad");
      expect(output).toContain("/workspace/.discord-assets/stickers/200/party.png");
      expect(output).toContain("Lottie stickers are not supported.");
    }),
  );
});
