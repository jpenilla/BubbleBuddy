import { type TaskId } from "@earendil-works/pi-durable";
import { type Snowflake } from "discord.js";
import { Effect } from "effect";

import { type SessionEventOf } from "../pi/session-events.ts";
import { createCompactionStatusEmbed, type CompactionStatus } from "./compaction-status-embed.ts";
import { OutputPump } from "./output-pump.ts";

export interface Interface {
  readonly start: (
    event: SessionEventOf<"compaction_start">,
  ) => Effect.Effect<void, unknown, OutputPump.Posting>;
  readonly end: (
    event: SessionEventOf<"compaction_end">,
  ) => Effect.Effect<void, unknown, OutputPump.Posting>;
}

export const create: Effect.Effect<Interface> = Effect.sync(() => {
  // Each live compaction and its status card; background compactions run beside the conversation's work.
  const compactions = new Map<TaskId, { readonly background: boolean; card?: Snowflake }>();

  const send = Effect.fnUntraced(function* (taskId: TaskId, status: CompactionStatus) {
    const embed = createCompactionStatusEmbed(status);
    const compaction = compactions.get(taskId);
    // Forgotten before posting, so a failed post does not leave it behind.
    if (status.phase !== "start") compactions.delete(taskId);
    const posting = yield* OutputPump.Posting;
    const card = compaction?.card;
    const sent =
      card === undefined
        ? yield* posting.send({ embeds: [embed] })
        : yield* posting.edit(card, { embeds: [embed] }).pipe(Effect.as(card));
    if (status.phase === "start" && compaction !== undefined) compaction.card = sent;
  });

  const start = Effect.fn("CompactionOutput.start")(function* (
    event: SessionEventOf<"compaction_start">,
  ) {
    // A compaction no request waits for runs while the conversation keeps working.
    const background = !event.blocking;
    compactions.set(event.taskId, { background });
    yield* send(event.taskId, { phase: "start", reason: event.reason, background });
  });

  const end = Effect.fn("CompactionOutput.end")(function* (
    event: SessionEventOf<"compaction_end">,
  ) {
    const { outcome, reason, taskId } = event;
    const background = compactions.get(taskId)?.background ?? false;
    const fail = (errorMessage: string) =>
      Effect.logError("Compaction failed").pipe(
        Effect.annotateLogs({ reason, errorMessage }),
        Effect.andThen(send(taskId, { phase: "error", reason, background, errorMessage })),
      );
    switch (outcome.status) {
      case "completed":
        return yield* outcome.result.entryId === undefined &&
        outcome.result.submissionId === undefined
          ? send(taskId, {
              phase: "error",
              reason,
              background,
              errorMessage: "Nothing to compact (session too small)",
            })
          : send(taskId, { phase: "success", reason, background });
      case "aborted":
        yield* Effect.logDebug("Compaction interrupted");
        return yield* send(taskId, { phase: "aborted", reason, background });
      case "failed":
      case "faulted":
        return yield* fail(outcome.error.message);
      case "orphaned":
        return yield* fail(outcome.reason);
    }
  });

  return { start, end };
});

export * as CompactionOutput from "./compaction-output.ts";
