import { EmbedBuilder } from "discord.js";

import { DISCORD_EMBED_DESCRIPTION_LIMIT } from "../shared/constants.ts";
import { truncate } from "../shared/text.ts";
import { EMBED_COLOR } from "./utils.ts";

export const createRunErrorEmbed = (errorMessage: string): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(EMBED_COLOR.danger)
    .setDescription(
      truncate(`❌ **Run failed**\n${errorMessage}`, DISCORD_EMBED_DESCRIPTION_LIMIT),
    );
