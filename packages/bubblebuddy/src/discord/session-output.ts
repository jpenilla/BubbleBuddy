import { type GuildTextBasedChannel } from "discord.js";
import { Cause, Effect, Match, type Scope } from "effect";

import { type SessionEvent, type SessionEventOf } from "../pi/session-events.ts";
import { CompactionOutput } from "./compaction-output.ts";
import { MessageOutput } from "./message-output.ts";
import { type OutputPump } from "./output-pump.ts";
import { RunOutput } from "./run-output.ts";
import { ToolOutputPolicies } from "./tool-output-policies.ts";
import { ToolOutput } from "./tool-output.ts";

interface CreateInput {
  readonly channel: GuildTextBasedChannel;
  readonly pump: OutputPump.Interface;
  readonly showThinking: Effect.Effect<boolean>;
}

/** Shows a session's events in its channel; each event is one unit of the pump's output. */
export const create = (
  input: CreateInput,
): Effect.Effect<(event: SessionEvent) => Effect.Effect<void>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const messageOutput = yield* MessageOutput.create(input);
    const toolOutput = yield* ToolOutput.create(ToolOutputPolicies.forTool);
    const compactionOutput = yield* CompactionOutput.create;
    const runOutput = yield* RunOutput.create;

    const onRunEnd = Effect.fn("SessionOutput.onRunEnd")(function* (
      event: SessionEventOf<"run_end">,
    ) {
      yield* messageOutput.stopTyping;
      yield* runOutput.end(event);
      yield* toolOutput.reset;
    });

    const handleEvent = Match.type<SessionEvent>().pipe(
      Match.discriminators("type")({
        message_update: messageOutput.update,
        message_end: (event) =>
          messageOutput.end(event).pipe(Effect.andThen(runOutput.messageEnd(event))),
        tool_execution_start: toolOutput.start,
        tool_execution_end: toolOutput.complete,
        auto_retry_start: runOutput.retry,
        compaction_start: compactionOutput.start,
        compaction_end: compactionOutput.end,
        run_end: onRunEnd,
      }),
      Match.orElse(() => Effect.void),
    );

    return (event: SessionEvent) =>
      input.pump.enqueue(
        Effect.suspend(() => handleEvent(event)).pipe(
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.logDebug("Session event handling interrupted", cause)
              : Effect.logError("Session event handling failed", cause),
          ),
          Effect.annotateLogs({ channelId: input.channel.id, eventType: event.type }),
          Effect.ignoreCause(),
          Effect.withSpan("SessionOutput.handleEvent"),
        ),
      );
  });

export * as SessionOutput from "./session-output.ts";
