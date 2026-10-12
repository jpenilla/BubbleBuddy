import { type JsonValue } from "@earendil-works/pi-ai";
import { MessageFlags, type ContainerBuilder, type Snowflake } from "discord.js";
import { Data, Effect } from "effect";

import { type SessionEventOf } from "../pi/session-events.ts";
import { OutputPump } from "./output-pump.ts";
import { createToolStatusComponents, type ToolStatusEntry } from "./tool-status-components.ts";
import { formatToolDescription } from "./tool-status-formatting.ts";

type StartEvent = SessionEventOf<"tool_execution_start">;
type EndEvent = SessionEventOf<"tool_execution_end">;

/** A tool call's outcome; a call without a result failed. */
export interface Result {
  readonly isError: boolean;
  readonly details: JsonValue | undefined;
}

export interface StandaloneFormatter {
  readonly begin: (event: StartEvent) => {
    readonly initial: ContainerBuilder;
    readonly complete: (result: Result) => Effect.Effect<ContainerBuilder, unknown>;
  };
}

export type Policy = Data.TaggedEnum<{
  Hidden: {};
  Grouped: {};
  Standalone: { readonly formatter: StandaloneFormatter };
}>;
export const Policy = Data.taggedEnum<Policy>();

export const standalonePolicy = (formatter: StandaloneFormatter) =>
  Policy.Standalone({ formatter });

export interface Interface {
  readonly start: (event: StartEvent) => Effect.Effect<void, unknown, OutputPump.Posting>;
  readonly complete: (event: EndEvent) => Effect.Effect<void, unknown, OutputPump.Posting>;
  /** Forgets the run's tool calls. */
  readonly reset: Effect.Effect<void>;
}

interface Group {
  readonly id: Snowflake;
  readonly entries: Map<string, ToolStatusEntry>;
}

const MAX_TOOLS_PER_GROUP = 8;

export const create = (policyFor: (name: string) => Policy): Effect.Effect<Interface> =>
  Effect.sync(() => {
    // The last group; it takes further grouped calls while it is the latest post.
    let appendable: Group | undefined;
    const pending = new Map<
      string,
      (result: Result) => Effect.Effect<void, unknown, OutputPump.Posting>
    >();
    const reset = Effect.sync(() => {
      appendable = undefined;
      pending.clear();
    });

    const renderGroup = (group: Group) =>
      OutputPump.Posting.use((posting) =>
        posting.edit(group.id, {
          components: [createToolStatusComponents(group.entries.values())],
        }),
      );

    const completeGroupEntry = (group: Group, toolCallId: string, result: Result) =>
      Effect.gen(function* () {
        const entry = group.entries.get(toolCallId);
        if (entry === undefined) {
          yield* Effect.logWarning("Grouped tool entry is missing").pipe(
            Effect.annotateLogs({ toolCallId }),
          );
          return;
        }
        group.entries.set(toolCallId, { ...entry, phase: result.isError ? "error" : "success" });
        yield* renderGroup(group);
      });

    const startGrouped = Effect.fn("ToolOutput.startGrouped")(function* (event: StartEvent) {
      const posting = yield* OutputPump.Posting;
      const entry: ToolStatusEntry = {
        phase: "running",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        description: formatToolDescription(event.toolName, event.args),
      };
      const previous = appendable;
      if (
        previous !== undefined &&
        posting.isLatest(previous.id) &&
        previous.entries.size < MAX_TOOLS_PER_GROUP
      ) {
        const group = previous;
        group.entries.set(entry.toolCallId, entry);
        pending.set(event.toolCallId, (result) =>
          completeGroupEntry(group, event.toolCallId, result),
        );
        yield* renderGroup(group);
        return;
      }

      const entries = new Map([[entry.toolCallId, entry]]);
      const id = yield* posting.send({
        flags: MessageFlags.IsComponentsV2,
        components: [createToolStatusComponents(entries.values())],
      });
      const created: Group = { id, entries };
      appendable = created;
      pending.set(event.toolCallId, (result) =>
        completeGroupEntry(created, event.toolCallId, result),
      );
    });

    const startStandalone = Effect.fn("ToolOutput.startStandalone")(function* (
      event: StartEvent,
      formatter: StandaloneFormatter,
    ) {
      const posting = yield* OutputPump.Posting;
      const output = formatter.begin(event);
      const id = yield* posting.send({
        flags: MessageFlags.IsComponentsV2,
        components: [output.initial],
      });
      pending.set(event.toolCallId, (result) =>
        Effect.gen(function* () {
          const components = yield* output.complete(result);
          yield* posting.edit(id, { components: [components] });
        }),
      );
    });

    const start = Effect.fn("ToolOutput.start")(function* (event: StartEvent) {
      yield* Policy.$match(policyFor(event.toolName), {
        Hidden: () => Effect.void,
        Grouped: () => startGrouped(event),
        Standalone: ({ formatter }) => startStandalone(event, formatter),
      });
    });
    const complete = Effect.fn("ToolOutput.complete")(function* (event: EndEvent) {
      const finish = pending.get(event.toolCallId);
      pending.delete(event.toolCallId);
      if (finish === undefined) return;
      const message = event.entry?.model?.[0];
      const result = message?.role === "toolResult" ? message : undefined;
      yield* finish({ isError: result?.isError ?? true, details: result?.details });
    });
    return { start, complete, reset };
  });

export * as ToolOutput from "./tool-output.ts";
