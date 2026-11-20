import { type GuildTextBasedChannel } from "discord.js";
import { Context } from "effect";

import { type Posting } from "./posting.ts";

export class DiscordToolContext extends Context.Service<
  DiscordToolContext,
  {
    readonly channel: GuildTextBasedChannel;
    readonly executeOrdered: Posting.ExecuteOrdered;
  }
>()("bubblebuddy/discord/DiscordToolContext") {}
