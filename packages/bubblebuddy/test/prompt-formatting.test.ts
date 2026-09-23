import { Collection, MessageFlags, MessageReferenceType, StickerFormatType } from "discord.js";
import { describe, expect, test } from "vitest";

import {
  formatMessageForPrompt,
  normalizeIncomingUserMentions,
} from "../src/discord/prompt-formatting.ts";
import { createTestMessage, createTestMessageSnapshot } from "./helpers.ts";

describe("prompt formatting", () => {
  test("normalizes Discord user mention ids to copyable mention references", () => {
    const normalized = normalizeIncomingUserMentions(
      "hey <@123> and <@!456>",
      new Map([
        ["123", "alice"],
        ["456", "bob"],
      ]),
    );

    expect(normalized).toBe("hey @alice mention=<@123> and @bob mention=<@456>");
  });

  test("formats incoming Discord messages with compact copyable mention references", () => {
    const formatted = formatMessageForPrompt(
      createTestMessage({
        id: "555",
        username: "jmp",
        authorId: "999",
        content: "<@123> what's my username?",
        mentions: new Map([["123", "bubblebuddy"]]),
      }),
    );

    expect(formatted).toBe(
      "[msg 555 user=jmp mention=<@999>]\n@bubblebuddy mention=<@123> what's my username?",
    );
  });

  test("includes reply reference when provided", () => {
    const formatted = formatMessageForPrompt(
      createTestMessage({
        id: "111",
        username: "alice",
        authorId: "222",
        content: "Hello there",
        reference: { type: MessageReferenceType.Default, messageId: "789" },
      }),
    );

    expect(formatted).toBe("[msg 111 user=alice mention=<@222> reply_to=789]\nHello there");
  });

  test("includes reply reference for empty content", () => {
    const formatted = formatMessageForPrompt(
      createTestMessage({
        id: "111",
        username: "alice",
        authorId: "222",
        content: "",
        reference: { messageId: "789" },
      }),
    );

    expect(formatted).toBe("[msg 111 user=alice mention=<@222> reply_to=789]");
  });

  test("formats embed and sticker metadata as meaningful prompt content", () => {
    const message = createTestMessage({
      content: "Look at this",
      embeds: [
        {
          toJSON: () => ({
            provider: { name: "provider" },
            author: { name: "author", icon_url: "author-icon" },
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
            image: { url: "image", proxy_url: "image-proxy", width: 640, height: 480 },
            thumbnail: { url: "thumbnail", proxy_url: "thumbnail-proxy", width: 320, height: 240 },
            video: { url: "video", proxy_url: "video-proxy", width: 1280, height: 720 },
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
    });

    const formatted = formatMessageForPrompt(message);
    const embedJson = formatted.match(/\[embed 0\]\n([\s\S]*?)\n\[\/embed 0\]/);
    expect(embedJson).not.toBeNull();
    const embed: Record<string, unknown> = JSON.parse(embedJson?.[1] ?? "null");

    expect(embed).toMatchObject({
      provider: { name: "provider" },
      author: { name: "author", icon: true },
      title: "title",
      url: "url",
      description: "description",
      fields: [{ name: "field", value: "value" }],
      footer: { text: "footer", icon: true },
      timestamp: "timestamp",
      image: { width: 640, height: 480 },
      thumbnail: { width: 320, height: 240 },
      video: { width: 1280, height: 720 },
    });
    for (const media of ["image", "thumbnail", "video"] as const) {
      expect(embed[media]).not.toHaveProperty("url");
      expect(embed[media]).not.toHaveProperty("proxy_url");
    }
    expect(embed.footer).not.toHaveProperty("icon_url");
    expect(embed.footer).not.toHaveProperty("proxy_icon_url");
    expect(formatted).toContain(
      "[sticker 0] id=sticker-1 name=wave format=APNG description=sticker-description tags=sticker-tags",
    );
  });

  test("formats the forwarded snapshot with normalized snapshot content", () => {
    const formatted = formatMessageForPrompt(
      createTestMessage({
        id: "outer-message",
        content: "",
        reference: {
          type: MessageReferenceType.Forward,
          messageId: "source-message",
          channelId: "source-channel",
          guildId: "source-guild",
        },
        messageSnapshots: new Map([
          [
            "source-message",
            createTestMessageSnapshot({
              content: "Forwarded <@123>",
              mentions: new Map([["123", "snapshot-user"]]),
              embeds: [{ toJSON: () => ({ title: "forwarded embed" }) }],
            }),
          ],
        ]),
      }),
    );

    expect(formatted).toContain("[forwarded]");
    expect(formatted).toContain("@snapshot-user mention=<@123>");
    expect(formatted).toContain("[embed 0]");
    expect(formatted).toMatch(/"title"\s*:\s*"forwarded embed"/);
    expect(formatted).not.toContain("reply_to=");
  });

  test("formats an attachment-only forwarded snapshot", () => {
    const formatted = formatMessageForPrompt(
      createTestMessage({
        content: "",
        reference: { type: MessageReferenceType.Forward, messageId: "source-message" },
        messageSnapshots: new Map([
          [
            "source-message",
            createTestMessageSnapshot({
              content: "",
              attachments: new Map([["attachment-1", { name: "../private/notes.txt", size: 42 }]]),
            }),
          ],
        ]),
      }),
    );

    const forwardedStart = formatted.indexOf("[forwarded");
    const forwardedEnd = formatted.indexOf("[/forwarded]");
    const attachmentBlock = "[attachments: [0] notes.txt 42]";
    const attachmentIndex = formatted.indexOf(attachmentBlock);

    expect(attachmentIndex).toBeGreaterThan(forwardedStart);
    expect(attachmentIndex).toBeLessThan(forwardedEnd);
  });

  test("keeps forwarded content alongside the Components V2 placeholder", () => {
    const formatted = formatMessageForPrompt(
      createTestMessage({
        content: "",
        flags: MessageFlags.IsComponentsV2,
        reference: { type: MessageReferenceType.Forward, messageId: "source-message" },
        messageSnapshots: new Map([
          ["source-message", createTestMessageSnapshot({ content: "Forwarded text" })],
        ]),
      }),
    );

    expect(formatted).toContain("[Discord Components V2 content display not yet implemented]");
    expect(formatted).toContain("Forwarded text");
    expect(formatted.indexOf("Components V2")).toBeLessThan(formatted.indexOf("Forwarded text"));
  });
});
