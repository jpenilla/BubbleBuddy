import { Events } from "discord.js";
import { Effect, Layer } from "effect";

import { Discord } from "../client.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { abortCommand } from "./abort.ts";
import { createCommandDispatcher } from "./command.ts";
import { compactCommand } from "./compact.ts";
import { discardSessionCommand } from "./discard-session.ts";
import { statusCommand } from "./status.ts";
import { thinkingCommand } from "./thinking.ts";

export const SlashCommandsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo("Registering Discord slash commands.");
    const discord = yield* Discord;
    const commands = yield* Effect.all([
      abortCommand,
      compactCommand,
      discardSessionCommand,
      statusCommand,
      thinkingCommand,
    ]);
    yield* tryDiscordJsPromise(() =>
      discord.client.application.commands.set(commands.map((command) => command.data.toJSON())),
    );
    yield* discord.events.forkOn(Events.InteractionCreate, createCommandDispatcher(commands));
    yield* Effect.logInfo("Discord slash commands registered.");
  }),
);
