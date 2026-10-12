import { type AssistantMessage } from "@earendil-works/pi-ai";
import { type GuildTextBasedChannel } from "discord.js";
import { Effect, type Scope } from "effect";

import { type SessionEventOf } from "../pi/session-events.ts";
import { OutputPump } from "./output-pump.ts";
import { splitThinkingStatus } from "./response-formatting.ts";
import { createTypingIndicator } from "./typing-indicator.ts";
import { type DiscordJsError } from "./utils.ts";

export interface Interface {
  /** Text streaming in keeps the typing indicator up; the answer is posted once committed. */
  readonly update: (event: SessionEventOf<"message_update">) => Effect.Effect<void>;
  /** Posts a committed answer's text, and its thinking when shown. */
  readonly end: (
    event: SessionEventOf<"message_end">,
  ) => Effect.Effect<void, DiscordJsError, OutputPump.Posting>;
  readonly stopTyping: Effect.Effect<void>;
}

interface CreateInput {
  readonly channel: GuildTextBasedChannel;
  readonly showThinking: Effect.Effect<boolean>;
}

export const create = (input: CreateInput): Effect.Effect<Interface, never, Scope.Scope> =>
  Effect.gen(function* () {
    const typingIndicator = yield* createTypingIndicator({ channel: input.channel });

    const update = (event: SessionEventOf<"message_update">) =>
      Effect.forEach(
        event.changes,
        (change) => {
          switch (change.type) {
            case "text_delta":
              return change.delta.length > 0 ? typingIndicator.activate : Effect.void;
            case "thinking_delta":
              return typingIndicator.deactivate;
            default:
              return Effect.void;
          }
        },
        { discard: true },
      );

    const sendBlock = Effect.fn("MessageOutput.sendBlock")(function* (
      block: AssistantMessage["content"][number],
    ) {
      if (block.type === "text" && block.text.trim().length > 0) {
        yield* typingIndicator.deactivate;
        yield* OutputPump.sendChunked({ content: block.text });
      } else if (block.type === "thinking" && block.thinking.trim().length > 0) {
        if (!(yield* input.showThinking)) return;
        yield* typingIndicator.deactivate;
        yield* Effect.forEach(
          splitThinkingStatus(block.thinking.trim()),
          (chunk) => OutputPump.send({ content: chunk }),
          { discard: true },
        );
      }
    });

    const end = Effect.fn("MessageOutput.end")(function* (event: SessionEventOf<"message_end">) {
      const message = event.entry.model?.[0];
      if (message?.role !== "assistant") return;
      yield* Effect.forEach(message.content, sendBlock, { discard: true });
      yield* typingIndicator.deactivate;
    });

    return { update, end, stopTyping: typingIndicator.deactivate };
  });

export * as MessageOutput from "./message-output.ts";
