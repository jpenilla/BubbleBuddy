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
import { type CardView, type Notice, type PostsView, type ToolResult } from "./state.ts";

/** A card's message: posted once, then edited. */
interface Card {
  readonly post: MessageCreateOptions;
  readonly edit: MessageEditOptions;
}

/** Renders a standalone tool card: pending until the call has a result. */
type CardFormatter = (args: unknown, result: ToolResult | undefined) => ContainerBuilder;

const cardFormatters = {
  create_schedule: ScheduleCard.create,
  update_schedule: ScheduleCard.update,
  cancel_schedule: ScheduleCard.cancel,
} satisfies Record<StandaloneCard, CardFormatter>;

const embedCard = (embed: EmbedBuilder): Card => ({
  post: { embeds: [embed] },
  edit: { embeds: [embed] },
});

const componentCard = (container: ContainerBuilder): Card => ({
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

export const renderPosts = (view: PostsView): MessageCreateOptions[] => {
  switch (view.type) {
    case "answer":
      return view.blocks.flatMap((block) =>
        (block.type === "text"
          ? splitDiscordMessage(block.text)
          : splitThinkingStatus(block.text)
        ).map((content) => ({ content })),
      );
    case "notice":
      return [{ embeds: [noticeEmbed(view.notice)] }];
  }
};

export const renderCard = (view: CardView): Card => {
  switch (view.type) {
    case "toolGroup":
      return componentCard(ToolsCard.create(view.rows));
    case "toolCard":
      return componentCard(cardFormatters[view.toolName](view.arguments, view.result));
    case "retry":
      return embedCard(RunCard.retry(view.status));
    case "compaction":
      return embedCard(CompactionCard.create(view.status));
  }
};
