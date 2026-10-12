import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type GuildTextBasedChannel } from "discord.js";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";

import { formatMessageForPrompt } from "../src/discord/prompt-formatting.ts";
import { DiscordToolContext } from "../src/discord/tool-context.ts";
import { fetchMessageTool } from "../src/discord/tools/fetch-message.ts";
import { createTestMessage, executeWithoutPosting, toolCall } from "./helpers.ts";

const createChannel = (fetch: (id: string) => Promise<unknown>): GuildTextBasedChannel =>
  ({ messages: { fetch } }) as unknown as GuildTextBasedChannel;

const createTool = (channel: GuildTextBasedChannel) =>
  fetchMessageTool.pipe(
    Effect.provideService(
      DiscordToolContext,
      DiscordToolContext.of({
        channel,
        executeOrdered: executeWithoutPosting,
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

    await expect(tool.execute({ messageId: "123" }, toolCall, BACKGROUND_CONTEXT)).rejects.toThrow(
      "Discord operation failed.",
    );
  });

  test("passes the requested ID to Discord and returns formatted content", async () => {
    const message = createTestMessage({ id: "fetched-message", content: "Fetched content" });
    const fetch = vi.fn(async () => message);
    const tool = await createTool(createChannel(fetch));
    const result = await tool.execute(
      { messageId: "requested-message" },
      toolCall,
      BACKGROUND_CONTEXT,
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("requested-message");
    expect(result.content).toEqual([{ type: "text", text: formatMessageForPrompt(message) }]);
  });
});
