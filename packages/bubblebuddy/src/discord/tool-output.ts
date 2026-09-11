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

export interface Interface {
  readonly start: (event: StartEvent) => Effect.Effect<void, unknown>;
  readonly complete: (event: EndEvent) => Effect.Effect<void, unknown>;
  readonly boundary: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

interface Group {
  readonly message: Message<true>;
  readonly entries: ToolStatusEntry[];
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
          components: [createToolStatusComponents(group.entries)],
        }),
      ).pipe(Effect.asVoid);

    const startGrouped = Effect.fn("ToolOutput.startGrouped")(function* (event: StartEvent) {
      const entry: ToolStatusEntry = {
        phase: "running",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        description: formatToolDescription(event.toolName, event.args),
      };
      let group = appendable;
      const isNew = group === undefined || group.entries.length >= MAX_TOOLS_PER_GROUP;
      if (group === undefined || group.entries.length >= MAX_TOOLS_PER_GROUP) {
        const entries = [entry];
        const message = yield* tryDiscordJsPromise(() =>
          channel.send({
            flags: MessageFlags.IsComponentsV2,
            components: [createToolStatusComponents(entries)],
          }),
        );
        group = { message, entries };
        appendable = group;
      } else {
        group.entries.push(entry);
      }
      const current = group;
      const index = current.entries.length - 1;
      pending.set(event.toolCallId, (end) =>
        Effect.gen(function* () {
          current.entries[index] = { ...entry, phase: end.isError ? "error" : "success" };
          yield* renderGroup(current);
        }),
      );
      if (!isNew) yield* renderGroup(current);
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
