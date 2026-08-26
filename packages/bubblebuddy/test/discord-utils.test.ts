import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { DiscordJsError, tryDiscordJsPromise } from "../src/discord/utils.ts";

describe("Discord promise errors", () => {
  test("tags rejected discord.js promises with their original cause", async () => {
    const cause = new Error("rate limited");
    const error = await Effect.runPromise(
      tryDiscordJsPromise(() => Promise.reject(cause)).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined,
        }),
      ),
    );

    expect(error).toBeInstanceOf(DiscordJsError);
    expect(error?.cause).toBe(cause);
  });
});
