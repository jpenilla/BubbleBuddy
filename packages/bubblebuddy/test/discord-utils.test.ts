import { DiscordAPIError, DiscordjsError, HTTPError, RateLimitError } from "discord.js";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { DiscordJsError, tryDiscordJsPromise } from "../src/discord/utils.ts";

const requestBody = { body: undefined, files: undefined };
const url = "https://discord.com/api/v10/channels/1/messages/2";

describe("Discord promise errors", () => {
  test.each([
    {
      name: "surfaces Discord API error codes and server messages",
      cause: new DiscordAPIError(
        { code: 10008, message: "Unknown Message" },
        10008,
        404,
        "GET",
        url,
        requestBody,
      ),
      expected: "Discord API error 10008: Unknown Message",
    },
    {
      name: "surfaces HTTP status text for non-API HTTP failures",
      cause: new HTTPError(502, "Bad Gateway", "GET", url, requestBody),
      expected: "Discord HTTP error 502: Bad Gateway",
    },
    {
      name: "surfaces route and retry delay for rate limit rejections",
      cause: new RateLimitError({
        timeToReset: 850,
        limit: 5,
        method: "PUT",
        hash: "hash",
        url,
        route: "/channels/:id/messages/:id/reactions",
        majorParameter: "1",
        global: false,
        retryAfter: 850,
        sublimitTimeout: 0,
        scope: "user",
      }),
      expected:
        "Discord rate limit on PUT /channels/:id/messages/:id/reactions (retry after 850ms)",
    },
    {
      name: "surfaces discord.js client error codes",
      // The typings mark the constructor private; construct through the runtime class.
      cause: Reflect.construct(DiscordjsError, [
        "ClientNotReady",
        "complete this request",
      ]) as Error,
      expected: "discord.js client error ClientNotReady:",
    },
    {
      name: "masks causes outside the discord.js error taxonomy",
      cause: new TypeError("fetch failed: getaddrinfo ENOTFOUND internal-host.example"),
      expected: "Discord operation failed.",
    },
  ])("$name", async ({ cause, expected }) => {
    const error = await Effect.runPromise(
      tryDiscordJsPromise(() => Promise.reject(cause)).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(DiscordJsError);
    expect(error.message).toContain(expected);
    expect(error.cause).toBe(cause);
  });
});
