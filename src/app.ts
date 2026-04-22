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
): Promise<void> => {
  const chunks = splitDiscordMessage(content);

  for (const chunk of chunks) {
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
  promptContext: {
    botName: client.user.username,
    channelName:
      "name" in message.channel && typeof message.channel.name === "string"
        ? message.channel.name
        : "unknown-channel",
    guildName: message.guild.name,
  },
  sessionId: `discord:${message.guildId}:${message.channelId}`,
  sink: createSessionSink(message.channel, config),
});

const createSessionSink = (channel: GuildTextBasedChannel, config: AppConfigShape) => {
  let typingTimer: ReturnType<typeof setInterval> | undefined;

  const stopTypingLoop = async (): Promise<void> => {
    if (typingTimer !== undefined) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  };

  return {
    onError: async (text: string) => {
      await sendChunkedMessage(channel, text);
    },
    onFinal: async (text: string) => {
      await sendChunkedMessage(channel, text);
    },
    onThinking: async (text: string) => {
      for (const chunk of splitThinkingStatus(text)) {
        await channel.send(chunk);
      }
    },
    onRunEnd: async () => {
      await stopTypingLoop();
    },
    onRunStart: async () => {
      if (typingTimer !== undefined) {
        return;
      }

      await channel.sendTyping();
      typingTimer = setInterval(() => {
        void channel.sendTyping().catch(() => undefined);
      }, config.typingIndicatorIntervalMs);
    },
    onStatus: async (text: string) => {
      await sendChunkedMessage(channel, text);
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
  const config = yield* loadAppConfig;
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = resolvePiModel(modelRegistry, config.modelProvider, config.modelId);
  const sessions = createChannelSessions({
    agentDir,
    authStorage,
    config,
    cwd: process.cwd(),
    model,
    modelRegistry,
  });

  const client = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const discordClient = makeDiscordClient();

      discordClient.on(Events.MessageCreate, (message) => {
        if (!message.inGuild()) {
          return;
        }

        void handleGuildMessage(discordClient as Client<true>, config, sessions, message);
      });

      discordClient.on(Events.InteractionCreate, (interaction) => {
        void handleInteraction(sessions, interaction);
      });

      await discordClient.login(config.discordToken);
      const readyClient = await waitForReady(discordClient);
      await registerSlashCommands(readyClient);
      return readyClient;
    }),
    (client) =>
      Effect.tryPromise(async () => {
        await sessions.waitForIdle();
        client.destroy();
      }),
  );

  yield* Effect.log(`Connected to Discord as ${client.user.tag}`);
  yield* Effect.never;
});
