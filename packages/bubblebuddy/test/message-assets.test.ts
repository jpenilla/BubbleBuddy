import { MessageReferenceType, type TopLevelComponent } from "discord.js";
import { describe, expect, test } from "vitest";

import { collectMessageAssets } from "../src/discord/message-assets.ts";
import { formatMessageForPrompt } from "../src/discord/prompt-formatting.ts";
import { createTestMessage, createTestMessageSnapshot } from "./helpers.ts";

const component = (data: unknown): TopLevelComponent =>
  ({ toJSON: () => data }) as TopLevelComponent;

describe("message assets", () => {
  test("keeps asset keys stable when component media gains a proxy URL", () => {
    const message = (proxyUrl?: string) =>
      createTestMessage({
        components: [
          component({
            type: 13,
            file: {
              url: "attachment://later.png",
              ...(proxyUrl === undefined ? {} : { proxy_url: proxyUrl }),
            },
          }),
          component({ type: 11, media: { url: "https://cdn.test/other" } }),
        ],
      });

    const before = collectMessageAssets(message());
    const after = collectMessageAssets(message("https://cdn.test/later.png"));
    expect(before.catalog.map(({ key, url }) => [key, url])).toEqual([
      ["a1", undefined],
      ["a2", "https://cdn.test/other"],
    ]);
    expect(after.catalog.map(({ key, url }) => [key, url])).toEqual([
      ["a1", "https://cdn.test/later.png"],
      ["a2", "https://cdn.test/other"],
    ]);
    expect(formatMessageForPrompt(message())).toContain('"asset": "a1"');
  });

  test("shares flat keys across attachments, embeds, and nested component media", () => {
    const message = createTestMessage({
      content: "",
      attachments: new Map([
        ["att", { name: "report.pdf", size: 12, url: "https://cdn.test/report" } as never],
        ["second", { name: "notes.txt", size: 24, url: "https://cdn.test/notes" } as never],
      ]),
      embeds: [{ toJSON: () => ({ image: { url: "https://cdn.test/embed", width: 32 } }) }],
      components: [
        component({
          type: 17,
          id: 41,
          accent_color: null,
          spoiler: false,
          components: [
            { type: 10, content: "Hello" },
            { type: 14, spacing: 2, divider: true },
            {
              type: 1,
              components: [
                { type: 2, label: "Open", style: 1, custom_id: "open", disabled: false },
              ],
            },
            {
              type: 12,
              items: [
                {
                  media: {
                    url: "https://cdn.test/gallery",
                    proxy_url: "https://proxy.test/gallery",
                    width: 64,
                  },
                  description: "Scene",
                },
              ],
            },
            {
              type: 9,
              components: [{ type: 10, content: "Preview" }],
              accessory: { type: 11, media: { url: "https://cdn.test/thumb" } },
            },
            { type: 13, file: { url: "attachment://report.pdf" }, name: "report.pdf" },
          ],
        }),
      ],
    });
    const resolved = collectMessageAssets(message);
    expect(resolved.catalog.map(({ key, url }) => [key, url])).toEqual([
      ["a1", "https://cdn.test/report"],
      ["a2", "https://cdn.test/notes"],
      ["a3", "https://cdn.test/embed"],
      ["a4", "https://proxy.test/gallery"],
      ["a5", "https://cdn.test/thumb"],
    ]);
    const formatted = formatMessageForPrompt(message);
    const container = JSON.parse(resolved.main.components[0]!);
    expect(container).toMatchObject({
      type: "container",
      components: [
        { type: "text_display", content: "Hello" },
        { type: "action_row", components: [{ type: "button", style: "primary", label: "Open" }] },
        { type: "media_gallery", items: [{ description: "Scene", media: { asset: "a4" } }] },
        { type: "section", accessory: { type: "thumbnail", media: { asset: "a5" } } },
        { type: "file", file: { asset: "a1" } },
      ],
    });
    expect(container).not.toHaveProperty("accent_color");
    expect(formatted).toContain("[attachments: report.pdf 12 asset=a1, notes.txt 24 asset=a2]");
    expect(formatted).not.toContain("https://cdn.test/gallery");
  });

  test("shares keys across the message and forwarded snapshot", () => {
    const message = createTestMessage({
      attachments: new Map([
        ["main", { name: "main.txt", size: 1, url: "https://cdn.test/main" } as never],
      ]),
      reference: { type: MessageReferenceType.Forward, messageId: "source" },
      messageSnapshots: new Map([
        [
          "source",
          createTestMessageSnapshot({
            attachments: new Map([
              [
                "forward",
                { name: "forward.txt", size: 2, url: "https://cdn.test/forward" } as never,
              ],
            ]),
          }),
        ],
      ]),
    });
    expect(
      collectMessageAssets(message).catalog.map(({ key, url, forwarded }) => ({
        key,
        url,
        forwarded,
      })),
    ).toEqual([
      { key: "a1", url: "https://cdn.test/main", forwarded: false },
      { key: "a2", url: "https://cdn.test/forward", forwarded: true },
    ]);
    const formatted = formatMessageForPrompt(message);
    expect(formatted).toContain("main.txt 1 asset=a1");
    expect(formatted).toContain("[forwarded]\nHello world");
    expect(formatted).toContain("forward.txt 2 asset=a2");
  });
});
