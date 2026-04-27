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
import type { PromptTemplateContext } from "./domain/prompt.ts";
import { formatMessageForPrompt } from "./discord/message-formatting.ts";
import { SHOW_THINKING_DEFAULT } from "./channel-repository.ts";
import { resolvePiModel } from "./pi/model.ts";
import { createChannelSessionManager, type ChannelSessionManager } from "./sessions.ts";

const COMPACT_COMMAND = new SlashCommandBuilder()
  .setName("compact")
  .setDescription("Manually compact this channel's session context.")
  .addStringOption((option) =>
    option
      .setName("instructions")
      .setDescription("Custom instructions for the compaction summary")
      .setRequired(false),
  );

const NEW_COMMAND = new SlashCommandBuilder()
  .setName("new")
  .setDescription("Discard this channel's current pi session.");

const THINKING_COMMAND = new SlashCommandBuilder()
  .setName("thinking")
  .setDescription("Toggle thinking messages in this channel.");

const isGuildTextChannel = (channel: unknown): channel is GuildTextBasedChannel =>
  typeof channel === "object" &&
  channel !== null &&
  "isSendable" in channel &&
  typeof channel.isSendable === "function" &&
  channel.isSendable();

const registerSlashCommands = async (client: Client<true>): Promise<void> => {
  await client.application.commands.set([
    COMPACT_COMMAND.toJSON(),
    NEW_COMMAND.toJSON(),
    THINKING_COMMAND.toJSON(),
  ]);
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

const createPromptContext = (
  client: Client<true>,
  channel: GuildTextBasedChannel,
  guildName: string,
): PromptTemplateContext => ({
  botName: client.user.username,
  channelName:
    "name" in channel && typeof channel.name === "string" ? channel.name : "unknown-channel",
  channelStatusText:
    "topic" in channel && typeof channel.topic === "string"
      ? channel.topic.trim().length > 0
        ? channel.topic.trim()
        : "none"
      : "none",
  guildName,
});

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
          promptContext: createPromptContext(client, message.channel, message.guild.name),
        },
        normalizedContent,
      );
    }),
  );

const handleInteraction = (
  client: Client<true>,
  sessions: ChannelSessionManager,
  interaction: Interaction,
) =>
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

      const guild = interaction.guild;
      if (guild === null) {
        await interaction.reply("This command only works in guild channels.");
        return;
      }

      if (interaction.commandName === "compact") {
        if (!isGuildTextChannel(interaction.channel)) {
          await interaction.reply("This command only works in guild text channels.");
          return;
        }

        const customInstructions =
          interaction.options.getString("instructions")?.trim() || undefined;
        await interaction.deferReply();
        const originMessage = (await interaction.fetchReply()) as Message<true>;
        const result = await sessions.compact(
          {
            channel: interaction.channel,
            originMessage,
            promptContext: createPromptContext(client, interaction.channel, guild.name),
          },
          customInstructions,
        );

        switch (result) {
          case "started":
            await interaction.editReply("Compaction requested.");
            break;
          case "no-session":
            await interaction.editReply("No session exists yet for this channel.");
            break;
          case "rejected-busy":
            await interaction.editReply("A response is already in progress for this channel.");
            break;
          case "rejected-compacting":
            await interaction.editReply("Compaction is already in progress for this channel.");
            break;
        }
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
    void handleInteraction(readyClient, sessions, interaction);
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
