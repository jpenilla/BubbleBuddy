import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  Collection,
  MessageFlagsBitField,
  StickerFormatType,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import { Effect } from "effect";

import { DiscordToolContext } from "../src/discord/tool-context.ts";
import { formatMessageForPrompt } from "../src/discord/prompt-formatting.ts";
import { fetchMessageTool } from "../src/discord/tools/fetch-message.ts";

const extensionContext = {} as ExtensionContext;

const createChannel = (fetch: (id: string) => Promise<unknown>): GuildTextBasedChannel =>
  ({ messages: { fetch } }) as unknown as GuildTextBasedChannel;

const createMessage = (options: {
  readonly content: string;
  readonly reference?: { readonly messageId: string; readonly channelId: string };
}): Message<true> =>
  ({
    id: "456",
    author: { username: "alice", id: "789" },
    content: options.content,
    mentions: { users: new Map() },
    reference: options.reference ?? null,
    channelId: "channel-1",
    attachments: new Collection(),
    embeds: [],
    flags: new MessageFlagsBitField(),
    stickers: new Collection(),
  }) as unknown as Message<true>;

const createTool = (channel: GuildTextBasedChannel) =>
  fetchMessageTool.pipe(
    Effect.provideService(
      DiscordToolContext,
      DiscordToolContext.of({
        channel,
        executeOrdered: (operation) => operation,
      }),
    ),
    Effect.runPromise,
  );

describe("fetch message tool", () => {
  test("hides Discord lookup details", async () => {
    const tool = await createTool(
      createChannel(async () => {
        throw new Error("DiscordAPIError[10008]: Unknown Message");
      }),
    );

    await expect(
      tool.execute("tool-call", { messageId: "123" }, undefined, undefined, extensionContext),
    ).rejects.toThrow("Discord operation failed.");
  });

  test.each([
    {
      name: "formats message content",
      reference: undefined,
      expected: "[msg 456 user=alice mention=<@789>] Hello world",
    },
    {
      name: "includes a reply reference",
      reference: { messageId: "111", channelId: "channel-1" },
      expected: "[msg 456 user=alice mention=<@789> reply_to=111] Hello world",
    },
  ])("$name", async ({ reference, expected }) => {
    const tool = await createTool(
      createChannel(async () => createMessage({ content: "Hello world", reference })),
    );
    const result = await tool.execute(
      "tool-call",
      { messageId: "456" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.content).toEqual([{ type: "text", text: expected }]);
  });

  test("includes embed and sticker metadata", () => {
    const message = {
      ...createMessage({ content: "Look at this" }),
      embeds: [
        {
          toJSON: () => ({
            provider: { name: "provider" },
            author: { name: "author" },
            title: "title",
            url: "url",
            description: "description",
            fields: [{ name: "field", value: "value" }],
            footer: {
              text: "footer",
              icon_url: "footer-icon",
              proxy_icon_url: "footer-icon-proxy",
            },
            timestamp: "timestamp",
            image: { url: "image", proxy_url: "image-proxy" },
            thumbnail: { url: "thumbnail", proxy_url: "thumbnail-proxy" },
            video: { url: "video", proxy_url: "video-proxy" },
          }),
        },
      ],
      stickers: new Collection([
        [
          "sticker-1",
          {
            id: "sticker-1",
            name: "wave",
            format: StickerFormatType.APNG,
            description: "sticker-description",
            tags: "sticker-tags",
          },
        ],
      ]),
    } as unknown as Message<true>;
    const formatted = formatMessageForPrompt(message);
    expect(formatted).toContain('[embed 0]\n{\n  "provider"');
    expect(formatted).toContain('"description": "description"');
    expect(formatted).toContain('"footer": {\n    "text": "footer",\n    "icon": true');
    expect(formatted).toContain('"video": {}');
    expect(formatted).not.toContain("proxy");
    expect(formatted).not.toContain('"url": "image"');
    expect(formatted).toContain("[/embed 0]");
    expect(formatted).toContain(
      "[sticker 0] id=sticker-1 name=wave format=APNG description=sticker-description tags=sticker-tags",
    );
  });
});
