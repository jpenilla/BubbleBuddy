import { Events } from "discord.js";
import { Effect, Layer } from "effect";

import { DiscordEvents } from "../discord-events.ts";
import { DiscordClient } from "../discord-client.ts";
import { tryDiscordJsPromise } from "../utils.ts";
import { abortCommand } from "./abort.ts";
import { createCommandDispatcher } from "./command.ts";
import { compactCommand } from "./compact.ts";
import { discardSessionCommand } from "./discard-session.ts";
import { statusCommand } from "./status.ts";
import { thinkingCommand } from "./thinking.ts";

export const SlashCommandsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const client = yield* DiscordClient.Service;
    const events = yield* DiscordEvents.Service;
    const commands = yield* Effect.all([
      abortCommand,
      compactCommand,
      discardSessionCommand,
      statusCommand,
      thinkingCommand,
    ]);
    yield* tryDiscordJsPromise(() =>
      client.application.commands.set(commands.map((command) => command.data.toJSON())),
    );
    yield* events.forkOn(Events.InteractionCreate, createCommandDispatcher(commands));
    yield* Effect.logInfo("Discord slash commands registered");
  }),
);
