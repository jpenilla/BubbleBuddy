import {
  type ContainerBuilder,
  type EmbedBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
  MessageFlags,
} from "discord.js";

import { splitDiscordMessage, splitThinkingStatus } from "../response-formatting.ts";
import { createRunErrorEmbed } from "../run-status-embed.ts";
import { CompactionCard } from "./cards/compaction.ts";
import { RunCard } from "./cards/run.ts";
import { ScheduleCard } from "./cards/schedule.ts";
import { ToolsCard } from "./cards/tools.ts";
import { type StandaloneCard } from "./policies.ts";
import { type ItemView, type Notice, type ToolResult } from "./state.ts";

/** How an item shows: one-off posts, or one card posted once and edited after. */
type Rendering =
  | { readonly type: "posts"; readonly posts: readonly MessageCreateOptions[] }
  | {
      readonly type: "card";
      readonly post: MessageCreateOptions;
      readonly edit: MessageEditOptions;
    };

/** Renders a standalone tool card: pending until the call has a result. */
type CardFormatter = (args: unknown, result: ToolResult | undefined) => ContainerBuilder;

const cardFormatters = {
  create_schedule: ScheduleCard.create,
  update_schedule: ScheduleCard.update,
  cancel_schedule: ScheduleCard.cancel,
} satisfies Record<StandaloneCard, CardFormatter>;

const embedCard = (embed: EmbedBuilder): Rendering => ({
  type: "card",
  post: { embeds: [embed] },
  edit: { embeds: [embed] },
});

const componentCard = (container: ContainerBuilder): Rendering => ({
  type: "card",
  post: { flags: MessageFlags.IsComponentsV2, components: [container] },
  edit: { components: [container] },
});

const noticeEmbed = (notice: Notice): EmbedBuilder => {
  switch (notice.type) {
    case "aborted":
      return RunCard.aborted();
    case "truncated":
      return RunCard.truncated();
    case "failure":
      return notice.reason === "model_error"
        ? RunCard.modelError(notice.message)
        : createRunErrorEmbed(notice.message);
  }
};

export const render = (view: ItemView): Rendering => {
  switch (view.type) {
    case "answer":
      return {
        type: "posts",
        posts: view.blocks.flatMap((block) =>
          (block.type === "text"
            ? splitDiscordMessage(block.text)
            : splitThinkingStatus(block.text)
          ).map((content) => ({ content })),
        ),
      };
    case "notice":
      return { type: "posts", posts: [{ embeds: [noticeEmbed(view.notice)] }] };
    case "toolGroup":
      return componentCard(ToolsCard.make(view.rows));
    case "toolCard":
      return componentCard(cardFormatters[view.toolName](view.arguments, view.result));
    case "retry":
      return embedCard(RunCard.retry(view.status));
    case "compaction":
      return embedCard(CompactionCard.make(view.status));
  }
};
