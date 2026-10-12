import { type GuildTextBasedChannel } from "discord.js";
import { Context } from "effect";

import { type OutputPump } from "./output-pump.ts";

export class DiscordToolContext extends Context.Service<
  DiscordToolContext,
  {
    readonly channel: GuildTextBasedChannel;
    readonly executeOrdered: OutputPump.ExecuteOrdered;
  }
>()("bubblebuddy/discord/DiscordToolContext") {}
