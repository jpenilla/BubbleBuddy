import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type { GuildTextBasedChannel } from "discord.js";
import { Effect } from "effect";

import { DiscordToolContext } from "../src/discord/tool-context.ts";
import { reactTool } from "../src/discord/tools/react.ts";

const extensionContext = {} as ExtensionContext;

const createChannel = (
  fetch: (id: string) => Promise<{ readonly react: (emoji: string) => Promise<void> }>,
): GuildTextBasedChannel => {
  const emojiId = "12345678901234567";
  const emojiCache = new Map<string, unknown>();
  const guild = { id: "guild", emojis: { cache: emojiCache } };
  emojiCache.set(emojiId, {
    id: emojiId,
    name: "wave",
    animated: false,
    available: true,
    guild,
    identifier: `wave:${emojiId}`,
    roles: { cache: new Map() },
  });
  return {
    messages: { fetch },
    permissionsFor: () => null,
    client: { user: { id: "bot" }, emojis: { cache: new Map() } },
    guild,
  } as unknown as GuildTextBasedChannel;
};

const createTool = (channel: GuildTextBasedChannel) =>
  reactTool.pipe(
    Effect.provideService(
      DiscordToolContext,
      DiscordToolContext.of({
        channel,
        executeOrdered: (operation) => operation,
      }),
    ),
    Effect.runPromise,
  );

describe("react tool", () => {
  test("adds multiple reactions", async () => {
    const reacted: string[] = [];
    const tool = await createTool(
      createChannel(async () => ({
        react: async (emoji) => {
          reacted.push(emoji);
        },
      })),
    );

    const result = await tool.execute(
      "tool-call",
      { messageId: "message", emojis: ["👍", "🎉"] },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.content).toEqual([{ type: "text", text: "Reactions added." }]);
    expect(reacted).toEqual(["👍", "🎉"]);
  });

  test("applies valid reactions and reports all failures", async () => {
    const reacted: string[] = [];
    const tool = await createTool(
      createChannel(async () => ({
        react: async (emoji) => {
          if (emoji === "🎉") throw new Error("blocked");
          reacted.push(emoji);
        },
      })),
    );

    await expect(
      tool.execute(
        "tool-call",
        {
          messageId: "message",
          emojis: ["👍", "<:wave:12345678901234567>", "🎉"],
        },
        undefined,
        undefined,
        extensionContext,
      ),
    ).rejects.toThrow("Failed to add reactions:\n🎉: blocked");
    expect(reacted).toEqual(["👍", "wave:12345678901234567"]);
  });
});
