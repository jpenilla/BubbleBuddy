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
import { Effect } from "effect";

import { loadAppConfig, type AppConfigShape } from "./config.ts";
import { createToolStatusEmbed, type ToolStatusEmbed } from "./discord/tool-status-embed.ts";
import { isActivationMessage } from "./domain/activation.ts";
import {
  formatIncomingDiscordMessage,
  splitDiscordMessage,
  splitThinkingStatus,
} from "./domain/text.ts";
import { resolvePiModel } from "./pi/model.ts";
import {
  createChannelSessions,
  type ChannelSessions,
  type SessionFactoryInput,
} from "./sessions.ts";

const NEW_COMMAND = new SlashCommandBuilder()
  .setName("new")
  .setDescription("Discard this channel's current pi session.");

const isGuildTextChannel = (channel: Message<true>["channel"]): channel is GuildTextBasedChannel =>
  channel.isSendable();

const registerSlashCommands = async (client: Client<true>): Promise<void> => {
  await client.application.commands.set([NEW_COMMAND.toJSON()]);
};

const waitForReady = async (client: Client): Promise<Client<true>> =>
  new Promise((resolve, reject) => {
    client.once(Events.ClientReady, (readyClient) => resolve(readyClient));
    client.once(Events.Error, reject);
  });

const sendChunkedMessage = async (
  channel: GuildTextBasedChannel,
  content: string,
  replyToMessageId?: string,
): Promise<void> => {
  const chunks = splitDiscordMessage(content);

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0 && replyToMessageId !== undefined) {
      await channel.send({
        content: chunk,
        reply: {
          failIfNotExists: false,
          messageReference: replyToMessageId,
        },
      });
      continue;
    }

    await channel.send(chunk);
  }
};

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

const normalizeMessageContent = (message: Message<true>): string =>
  formatIncomingDiscordMessage(
    message.id,
    message.author.username,
    message.author.id,
    message.content,
    new Map([...message.mentions.users.values()].map((user) => [user.id, user.username])),
  );

const createSessionInput = (
  message: Message<true>,
  client: Client<true>,
  config: AppConfigShape,
): SessionFactoryInput => ({
  channelId: message.channelId,
  originMessage: message,
  promptContext: {
    botName: client.user.username,
    channelName:
      "name" in message.channel && typeof message.channel.name === "string"
        ? message.channel.name
        : "unknown-channel",
    guildName: message.guild.name,
  },
  sink: createSessionSink(message.channel, config),
});

const createSessionSink = (channel: GuildTextBasedChannel, config: AppConfigShape) => {
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let toolStatusMessages = new Map<string, Message<true>>();

  const stopTypingLoop = async (): Promise<void> => {
    if (typingTimer !== undefined) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  };

  const resetRunToolStatusMessages = (): void => {
    toolStatusMessages = new Map<string, Message<true>>();
  };

  return {
    onError: async (text: string) => {
      await sendChunkedMessage(channel, text);
    },
    onFinal: async (text: string, replyToMessageId: string) => {
      await sendChunkedMessage(channel, text, replyToMessageId);
    },
    onThinking: async (text: string) => {
      for (const chunk of splitThinkingStatus(text)) {
        await channel.send(chunk);
      }
    },
    onRunEnd: async () => {
      resetRunToolStatusMessages();
      await stopTypingLoop();
    },
    onRunStart: async () => {
      resetRunToolStatusMessages();
      if (typingTimer !== undefined) {
        return;
      }

      await channel.sendTyping();
      typingTimer = setInterval(() => {
        void channel.sendTyping().catch(() => undefined);
      }, config.typingIndicatorIntervalMs);
    },
    onStatus: async (status: ToolStatusEmbed) => {
      const embed = createToolStatusEmbed(status);
      const existing = toolStatusMessages.get(status.toolCallId);
      if (existing !== undefined) {
        await existing.edit({ embeds: [embed] });
        if (status.phase === "end") {
          toolStatusMessages.delete(status.toolCallId);
        }
        return;
      }

      const sent = await channel.send({ embeds: [embed] });
      if (status.phase === "start") {
        toolStatusMessages.set(status.toolCallId, sent);
      }
    },
  };
};

const handleGuildMessage = (
  client: Client<true>,
  config: AppConfigShape,
  sessions: ChannelSessions,
  message: Message<true>,
): Promise<void> =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      if (!isGuildTextChannel(message.channel)) {
        return;
      }

      const activation = {
        isFromBot: message.author.bot,
        isReplyToBot: await isReplyToBot(message, client.user.id),
        mentionsBot: message.mentions.has(client.user),
      };

      if (!isActivationMessage(activation)) {
        return;
      }

      const normalizedContent = normalizeMessageContent(message);
      await sessions.activate(createSessionInput(message, client, config), normalizedContent);
    }),
  );

const handleInteraction = (sessions: ChannelSessions, interaction: Interaction) =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== "new") {
        return;
      }

      if (!interaction.inGuild() || interaction.channel === null) {
        await interaction.reply({
          content: "This command only works in guild channels.",
          ephemeral: true,
        });
        return;
      }

      const result = await sessions.discard(interaction.channelId);
      if (result === "rejected-busy") {
        await interaction.reply("A response is already in progress for this channel.");
        return;
      }

      await interaction.reply("The next bot interaction in this channel will use a new session.");
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
  const sessions = createChannelSessions({
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
    await client.login(config.discordToken);
    return await ready;
  });

  yield* Effect.logInfo("Registering Discord slash commands.");
  yield* Effect.tryPromise(() => registerSlashCommands(readyClient));
  yield* Effect.logInfo("Discord slash commands registered.");

  yield* Effect.logInfo(`Connected to Discord as ${readyClient.user.tag}`);
  yield* Effect.never;
});
