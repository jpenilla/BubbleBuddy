import { DEFAULT_RETRY_POLICY } from "@earendil-works/pi-durable";
import { type EmbedBuilder, type Snowflake } from "discord.js";
import { Effect } from "effect";

import { type SessionEventOf } from "../pi/session-events.ts";
import { OutputPump } from "./output-pump.ts";
import {
  createModelRequestErrorEmbed,
  createResponseTruncatedEmbed,
  createRetryStatusEmbed,
  createRunAbortedEmbed,
  createRunErrorEmbed,
  type RetryStatus,
} from "./run-status-embed.ts";

export interface Interface {
  /** A failed attempt is being retried. */
  readonly retry: (
    event: SessionEventOf<"auto_retry_start">,
  ) => Effect.Effect<void, unknown, OutputPump.Posting>;
  /** An answer ended; errors and aborts are reported by a retry or the run's end. */
  readonly messageEnd: (
    event: SessionEventOf<"message_end">,
  ) => Effect.Effect<void, unknown, OutputPump.Posting>;
  /** The run ended. */
  readonly end: (
    event: SessionEventOf<"run_end">,
  ) => Effect.Effect<void, unknown, OutputPump.Posting>;
}

interface RetryCard {
  readonly id: Snowflake;
  readonly attempt: number;
  readonly errors: readonly string[];
}

/** A run whose inputs went unanswered for a reason no answer reports. */
const formatRunError = (reason: string, detail: unknown): string =>
  `The model request failed: ${detail === undefined ? reason : `${reason}: ${JSON.stringify(detail)}`}`;

export const create: Effect.Effect<Interface> = Effect.sync(() => {
  let retryCard: RetryCard | undefined;

  const post = (embed: EmbedBuilder) => OutputPump.send({ embeds: [embed] }).pipe(Effect.asVoid);

  const finishRetry = (
    current: RetryCard,
    phase: Exclude<RetryStatus["phase"], "retrying">,
    finalError?: string,
  ) =>
    Effect.gen(function* () {
      const errors = finalError === undefined ? current.errors : [...current.errors, finalError];
      const embed = createRetryStatusEmbed({ phase, attempt: current.attempt, errors });
      yield* OutputPump.Posting.use((posting) => posting.edit(current.id, { embeds: [embed] }));
      retryCard = undefined;
    });

  const retry = Effect.fn("RunOutput.retry")(function* (event: SessionEventOf<"auto_retry_start">) {
    const existing = retryCard;
    const errors = [...(existing?.errors ?? []), event.errorMessage];
    const embed = createRetryStatusEmbed({
      phase: "retrying",
      attempt: event.attempt,
      maxAttempts: DEFAULT_RETRY_POLICY.maxRetries,
      errors,
    });
    const posting = yield* OutputPump.Posting;
    const id =
      existing === undefined
        ? yield* posting.send({ embeds: [embed] })
        : yield* posting.edit(existing.id, { embeds: [embed] }).pipe(Effect.as(existing.id));
    retryCard = { id, attempt: event.attempt, errors };
  });

  const messageEnd = Effect.fn("RunOutput.messageEnd")(function* (
    event: SessionEventOf<"message_end">,
  ) {
    const message = event.entry.model?.[0];
    if (message?.role !== "assistant") return;
    switch (message.stopReason) {
      // A retry or the run's end reports these; an error that triggers compaction is not a failure.
      case "error":
      case "aborted":
        return;
      default:
        if (retryCard !== undefined) yield* finishRetry(retryCard, "success");
        if (message.stopReason === "length") yield* post(createResponseTruncatedEmbed());
    }
  });

  const end = Effect.fn("RunOutput.end")(function* (event: SessionEventOf<"run_end">) {
    const settled = event.settled;
    if (settled?.status === "unanswered") {
      switch (settled.reason) {
        case "aborted":
          yield* retryCard === undefined
            ? post(createRunAbortedEmbed())
            : finishRetry(retryCard, "aborted");
          break;
        case "model_error": {
          const errorMessage =
            typeof settled.detail === "string"
              ? settled.detail
              : "The model request failed without an error message.";
          yield* retryCard === undefined
            ? post(createModelRequestErrorEmbed(errorMessage))
            : finishRetry(retryCard, "failure", errorMessage);
          break;
        }
        default: {
          const errorMessage = formatRunError(settled.reason, settled.detail);
          yield* retryCard === undefined
            ? post(createRunErrorEmbed(errorMessage))
            : finishRetry(retryCard, "failure", errorMessage);
        }
      }
    }
    retryCard = undefined;
  });

  return { retry, messageEnd, end };
});

export * as RunOutput from "./run-output.ts";
