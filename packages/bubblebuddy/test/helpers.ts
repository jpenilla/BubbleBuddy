import {
  Collection,
  type MessageReferenceType,
  type Attachment,
  type Embed,
  type Message,
  type MessageSnapshot,
  type Sticker,
  type TopLevelComponent,
} from "discord.js";
import { Layer, Redacted } from "effect";

import { EnvConfig, type EnvConfigShape } from "../src/config/env.ts";

const defaultEnvConfig: EnvConfigShape = {
  appHome: "/tmp/bb-test",
  discordToken: Redacted.make("test-token"),
};

export const createTestEnvConfig = (overrides: Partial<EnvConfigShape> = {}): EnvConfigShape => ({
  ...defaultEnvConfig,
  ...overrides,
});

export const createTestEnvLayer = (overrides: Partial<EnvConfigShape> = {}) =>
  Layer.succeed(EnvConfig, createTestEnvConfig(overrides));

type TestEmbed = Pick<Embed, "toJSON">;
type TestAttachment = Pick<Attachment, "name" | "size">;
type TestSticker = Pick<Sticker, "id" | "name" | "format" | "description" | "tags">;

type TestMessageOptions = {
  readonly id?: string;
  readonly username?: string;
  readonly authorId?: string;
  readonly content?: string;
  readonly channelId?: string;
  readonly mentions?: ReadonlyMap<string, string>;
  readonly reference?: {
    readonly messageId: string;
    readonly channelId?: string;
    readonly guildId?: string;
    readonly type?: MessageReferenceType;
  };
  readonly attachments?: ReadonlyMap<string, TestAttachment>;
  readonly embeds?: readonly TestEmbed[];
  readonly stickers?: ReadonlyMap<string, TestSticker>;
  readonly components?: readonly TopLevelComponent[];
  readonly messageSnapshots?: ReadonlyMap<string, MessageSnapshot>;
};

export const createTestMessage = (options: TestMessageOptions = {}): Message<true> =>
  ({
    id: options.id ?? "456",
    author: {
      username: options.username ?? "alice",
      id: options.authorId ?? "789",
    },
    content: options.content ?? "Hello world",
    channelId: options.channelId ?? "channel-1",
    mentions: {
      users: new Collection(
        [...(options.mentions ?? new Map()).entries()].map(([id, username]) => [
          id,
          { id, username },
        ]),
      ),
    },
    reference: options.reference ?? null,
    attachments: new Collection([...(options.attachments ?? new Map()).entries()]),
    embeds: options.embeds ?? [],
    components: options.components ?? [],
    stickers: new Collection([...(options.stickers ?? new Map()).entries()]),
    messageSnapshots: new Collection([...(options.messageSnapshots ?? new Map()).entries()]),
  }) as unknown as Message<true>;

type TestMessageBodyOptions = Pick<
  TestMessageOptions,
  "content" | "mentions" | "attachments" | "embeds" | "stickers" | "components"
>;

export const createTestMessageSnapshot = (
  options: TestMessageBodyOptions = {},
): MessageSnapshot => {
  const message = createTestMessage(options);
  return {
    author: null,
    content: message.content,
    mentions: message.mentions,
    attachments: message.attachments,
    embeds: message.embeds,
    stickers: message.stickers,
    components: message.components,
  } as unknown as MessageSnapshot;
};
