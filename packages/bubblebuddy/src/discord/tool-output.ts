import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  MessageFlags,
  type GuildTextBasedChannel,
  type Message,
  type ContainerBuilder,
} from "discord.js";
import { Data, Effect } from "effect";
import { createToolStatusComponents, type ToolStatusEntry } from "./tool-status-components.ts";
import { formatToolDescription } from "./tool-status-formatting.ts";
import { tryDiscordJsPromise } from "./utils.ts";

export type StartEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
export type EndEvent = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

export interface StandaloneFormatter {
  readonly begin: (event: StartEvent) => {
    readonly initial: ContainerBuilder;
    readonly complete: (event: EndEvent) => Effect.Effect<ContainerBuilder, unknown>;
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
  readonly start: (event: StartEvent) => Effect.Effect<void, unknown>;
  readonly complete: (event: EndEvent) => Effect.Effect<void, unknown>;
  readonly boundary: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

interface Group {
  readonly message: Message<true>;
  readonly entries: Map<string, ToolStatusEntry>;
}

const MAX_TOOLS_PER_GROUP = 8;

export const make = (
  channel: GuildTextBasedChannel,
  policyFor: (name: string) => Policy,
): Effect.Effect<Interface> =>
  Effect.sync(() => {
    let appendable: Group | undefined;
    const pending = new Map<string, (event: EndEvent) => Effect.Effect<void, unknown>>();
    const boundary = Effect.sync(() => {
      appendable = undefined;
    });
    const reset = Effect.sync(() => {
      appendable = undefined;
      pending.clear();
    });

    const renderGroup = (group: Group) =>
      tryDiscordJsPromise(() =>
        group.message.edit({
          components: [createToolStatusComponents(group.entries.values())],
        }),
      ).pipe(Effect.asVoid);

    const completeGroupEntry = (group: Group, toolCallId: string, end: EndEvent) =>
      Effect.gen(function* () {
        const entry = group.entries.get(toolCallId);
        if (entry === undefined) {
          return yield* Effect.die(new Error(`Grouped tool entry "${toolCallId}" is missing`));
        }
        group.entries.set(toolCallId, { ...entry, phase: end.isError ? "error" : "success" });
        yield* renderGroup(group);
      });

    const startGrouped = Effect.fn("ToolOutput.startGrouped")(function* (event: StartEvent) {
      const entry: ToolStatusEntry = {
        phase: "running",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        description: formatToolDescription(event.toolName, event.args),
      };
      const previous = appendable;
      if (previous !== undefined && previous.entries.size < MAX_TOOLS_PER_GROUP) {
        const group = previous;
        group.entries.set(entry.toolCallId, entry);
        pending.set(event.toolCallId, (end) => completeGroupEntry(group, end.toolCallId, end));
        yield* renderGroup(group);
        return;
      }

      const entries = new Map([[entry.toolCallId, entry]]);
      const message = yield* tryDiscordJsPromise(() =>
        channel.send({
          flags: MessageFlags.IsComponentsV2,
          components: [createToolStatusComponents(entries.values())],
        }),
      );
      const created: Group = { message, entries };
      appendable = created;
      pending.set(event.toolCallId, (end) => completeGroupEntry(created, end.toolCallId, end));
    });

    const startStandalone = Effect.fn("ToolOutput.startStandalone")(function* (
      event: StartEvent,
      formatter: StandaloneFormatter,
    ) {
      yield* boundary;
      const output = formatter.begin(event);
      const message = yield* tryDiscordJsPromise(() =>
        channel.send({
          flags: MessageFlags.IsComponentsV2,
          components: [output.initial],
        }),
      );
      pending.set(event.toolCallId, (end) =>
        Effect.gen(function* () {
          const components = yield* output.complete(end);
          yield* tryDiscordJsPromise(() => message.edit({ components: [components] }));
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
      if (finish !== undefined) yield* finish(event);
    });
    return { start, complete, boundary, reset };
  });

export * as ToolOutput from "./tool-output.ts";
