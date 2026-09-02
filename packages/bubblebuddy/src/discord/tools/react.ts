import { Effect, Result } from "effect";
import { Type } from "typebox";

import { normalizeReactionEmoji } from "../assets.ts";
import { DiscordToolContext } from "../tool-context.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { AgentToolError, defineEffectTool } from "../../pi/effect-tool.ts";

export const reactTool = defineEffectTool({
  name: "discord_react",
  label: "React",
  description: "React to a message in the current channel.",
  promptSnippet: "React to a message in the current channel",
  parameters: Type.Object({
    emojis: Type.Array(
      Type.String({
        description: "Unicode emoji or custom emoji in exact <:name:id> or <a:name:id> syntax",
      }),
    ),
    messageId: Type.String({ description: "Message ID" }),
  }),
  execute: (_toolCallId, params) =>
    Effect.gen(function* () {
      const context = yield* DiscordToolContext;
      const targetMessage = yield* tryDiscordJsPromise(() =>
        context.channel.messages.fetch(params.messageId),
      );
      const failures: string[] = [];

      for (const input of params.emojis) {
        const emoji = normalizeReactionEmoji(context, input);
        if (emoji === null) {
          failures.push(`${input}: invalid or not available`);
          continue;
        }

        const result = yield* context
          .executeOrdered(tryDiscordJsPromise(() => targetMessage.react(emoji)))
          .pipe(Effect.result);
        if (Result.isFailure(result)) {
          const raw = result.failure.cause;
          failures.push(`${emoji}: ${raw instanceof Error ? raw.message : String(raw)}`);
        }
      }

      if (failures.length > 0) {
        return yield* new AgentToolError({
          message: `Failed to add reactions: ${failures.join("; ")}`,
        });
      }
      return {
        content: [{ type: "text", text: "Reactions added." }],
        details: undefined,
      };
    }),
});
