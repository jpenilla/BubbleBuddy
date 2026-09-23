import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type GuildTextBasedChannel } from "discord.js";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";

import { formatMessageForPrompt } from "../src/discord/prompt-formatting.ts";
import { DiscordToolContext } from "../src/discord/tool-context.ts";
import { fetchMessageTool } from "../src/discord/tools/fetch-message.ts";
import { createTestMessage } from "./helpers.ts";

const extensionContext = {} as ExtensionContext;

const createChannel = (fetch: (id: string) => Promise<unknown>): GuildTextBasedChannel =>
  ({ messages: { fetch } }) as unknown as GuildTextBasedChannel;

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

  test("passes the requested ID to Discord and returns formatted content", async () => {
    const message = createTestMessage({ id: "fetched-message", content: "Fetched content" });
    const fetch = vi.fn(async () => message);
    const tool = await createTool(createChannel(fetch));
    const result = await tool.execute(
      "tool-call",
      { messageId: "requested-message" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("requested-message");
    expect(result.content).toEqual([{ type: "text", text: formatMessageForPrompt(message) }]);
  });
});
