import { Context } from "effect";
import type { GuildTextBasedChannel } from "discord.js";

import type { ExecuteOrderedDiscordAction } from "./session-output-pump.ts";

export class DiscordToolContext extends Context.Service<
  DiscordToolContext,
  {
    readonly channel: GuildTextBasedChannel;
    readonly executeOrdered: ExecuteOrderedDiscordAction;
  }
>()("bubblebuddy/discord/DiscordToolContext") {}
