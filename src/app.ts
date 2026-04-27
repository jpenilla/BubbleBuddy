import { getAgentDir, AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  Message,
  SlashCommandBuilder,
  type GuildTextBasedChannel,
} from "discord.js";
import { Effect, Redacted } from "effect";

import { loadAppConfig, type AppConfigShape } from "./config.ts";
import { isActivationMessage } from "./domain/activation.ts";
import { formatMessageForPrompt } from "./discord/message-formatting.ts";
import { SHOW_THINKING_DEFAULT } from "./channel-repository.ts";
import { resolvePiModel } from "./pi/model.ts";
import { createChannelSessionManager, type ChannelSessionManager } from "./sessions.ts";

const NEW_COMMAND = new SlashCommandBuilder()
  .setName("new")
  .setDescription("Discard this channel's current pi session.");

const THINKING_COMMAND = new SlashCommandBuilder()
  .setName("thinking")
  .setDescription("Toggle thinking messages in this channel.");

const isGuildTextChannel = (channel: Message<true>["channel"]): channel is GuildTextBasedChannel =>
  channel.isSendable();

const registerSlashCommands = async (client: Client<true>): Promise<void> => {
  await client.application.commands.set([NEW_COMMAND.toJSON(), THINKING_COMMAND.toJSON()]);
};

const waitForReady = async (client: Client): Promise<Client<true>> =>
  new Promise((resolve, reject) => {
    client.once(Events.ClientReady, (readyClient) => resolve(readyClient));
    client.once(Events.Error, reject);
  });

const isReplyToBot = async (message: Message<true>, botUserId: string): Promise<boolean> => {
  if (message.reference?.messageId === undefined) {
    return false;
  }

  try {
    const referencedMessage = await message.fetchReference();
    return referencedMessage.author.id === botUserId;
  } catch {
    return false;
  }
};

const handleGuildMessage = (
  client: Client<true>,
  config: AppConfigShape,
  sessions: ChannelSessionManager,
  message: Message<true>,
): Promise<void> =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      if (!isGuildTextChannel(message.channel)) {
        return;
      }

      const activation = {
        isReplyToBot: await isReplyToBot(message, client.user.id),
        mentionsBot: message.mentions.has(client.user),
      };

      if (!isActivationMessage(activation)) {
        return;
      }

      const normalizedContent = formatMessageForPrompt(message);
      await sessions.activate(
        {
          channel: message.channel,
          originMessage: message,
          promptContext: {
            botName: client.user.username,
            channelName:
              "name" in message.channel && typeof message.channel.name === "string"
                ? message.channel.name
                : "unknown-channel",
            channelStatusText:
              "topic" in message.channel && typeof message.channel.topic === "string"
                ? message.channel.topic.trim().length > 0
                  ? message.channel.topic.trim()
                  : "none"
                : "none",
            guildName: message.guild.name,
          },
        },
        normalizedContent,
      );
    }),
  );

const handleInteraction = (sessions: ChannelSessionManager, interaction: Interaction) =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      if (!interaction.inGuild() || interaction.channel === null) {
        await interaction.reply({
          content: "This command only works in guild channels.",
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "new") {
        const result = await sessions.discard(interaction.channelId);
        if (result === "rejected-busy") {
          await interaction.reply("A response is already in progress for this channel.");
          return;
        }

        await interaction.reply("The next bot interaction in this channel will use a new session.");
        return;
      }

      if (interaction.commandName === "thinking") {
        let reply: string;
        try {
          const newValue = await sessions.withChannel(interaction.channelId, async (channel) => {
            const value = !(channel.settings.showThinking ?? SHOW_THINKING_DEFAULT);
            channel.modifySettings((settings) => {
              settings.showThinking = value === SHOW_THINKING_DEFAULT ? undefined : value;
            });
            return value;
          });
          reply = `Thinking messages are now ${newValue ? "enabled" : "disabled"} in this channel.`;
        } catch (error) {
          void Effect.runFork(Effect.logWarning("Failed to update thinking setting", error));
          reply = "Failed to update the thinking setting. Please try again later.";
        }
        await interaction.reply(reply);
        return;
      }
    }),
  );

const makeDiscordClient = (): Client =>
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

export const program = Effect.gen(function* () {
  yield* Effect.logInfo("Starting BubbleBuddy.");
  const config = yield* loadAppConfig;
  yield* Effect.logInfo("Configuration loaded.");
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = resolvePiModel(modelRegistry, config.modelProvider, config.modelId);
  const sessions = createChannelSessionManager({
    agentDir,
    authStorage,
    config,
    model,
    modelRegistry,
  });

  yield* Effect.logInfo("Pi model initialized.");

  const client = yield* Effect.acquireRelease(Effect.sync(makeDiscordClient), (client) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("Shutdown requested. Stopping Discord intake.");
      client.removeAllListeners(Events.MessageCreate);
      client.removeAllListeners(Events.InteractionCreate);

      yield* Effect.logInfo("Shutting down channel sessions.");
      yield* Effect.tryPromise(() => sessions.shutdown()).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.logWarning("Timed out waiting for sessions to shut down."),
        }),
        Effect.catch((error: unknown) =>
          Effect.logWarning(`Session shutdown failed: ${String(error)}`),
        ),
      );

      yield* Effect.logInfo("Destroying Discord client.");
      client.destroy();
      yield* Effect.logInfo("Shutdown cleanup complete.");
    }),
  );

  client.on(Events.MessageCreate, (message) => {
    if (!message.inGuild()) {
      return;
    }

    void handleGuildMessage(client as Client<true>, config, sessions, message);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(sessions, interaction);
  });

  yield* Effect.logInfo("Logging into Discord.");
  const readyClient = yield* Effect.tryPromise(async () => {
    const ready = waitForReady(client);
    await client.login(Redacted.value(config.discordToken));
    return await ready;
  });

  yield* Effect.logInfo("Registering Discord slash commands.");
  yield* Effect.tryPromise(() => registerSlashCommands(readyClient));
  yield* Effect.logInfo("Discord slash commands registered.");

  yield* Effect.logInfo(`Connected to Discord as ${readyClient.user.tag}`);
  return yield* Effect.never;
});
