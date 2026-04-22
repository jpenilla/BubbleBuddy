import {
  PermissionFlagsBits,
  StickerType,
  type GuildEmoji,
  type Message,
  type Sticker,
} from "discord.js";

export type UsableSticker = {
  readonly guildId: string | null;
  readonly guildName: string | null;
  readonly packName: string | null;
  readonly sticker: Sticker;
};

const currentContextPermissions = (message: Message<true>) => {
  if (!message.client.user) {
    return null;
  }

  return message.channel.permissionsFor(message.client.user);
};

const sortByContextAndName = <T extends { readonly id: string; readonly name: string }>(
  items: ReadonlyArray<T>,
  currentGuildId: string,
  guildIdOf: (item: T) => string | null,
): T[] =>
  [...items].sort((left, right) => {
    const leftContext = guildIdOf(left) === currentGuildId ? 0 : 1;
    const rightContext = guildIdOf(right) === currentGuildId ? 0 : 1;
    return (
      leftContext - rightContext ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id)
    );
  });

const uniqueBy = <T>(items: Iterable<T>, keyOf: (item: T) => string): T[] => {
  const unique = new Map<string, T>();
  for (const item of items) {
    unique.set(keyOf(item), item);
  }
  return [...unique.values()];
};

const canUseEmojiRoles = (emoji: GuildEmoji): boolean => {
  if (emoji.roles.cache.size === 0) {
    return true;
  }

  const member = emoji.guild.members.me;
  if (!member) {
    return false;
  }

  return emoji.roles.cache.some((role) => member.roles.cache.has(role.id));
};

export const formatCustomEmoji = (emoji: GuildEmoji): string =>
  `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;

export const listUsableCustomEmojis = (message: Message<true>): GuildEmoji[] => {
  const allowExternal =
    currentContextPermissions(message)?.has(PermissionFlagsBits.UseExternalEmojis) ?? false;
  const currentGuildId = message.guild.id;
  const candidates = [
    ...message.guild.emojis.cache.values(),
    ...(allowExternal
      ? [...message.client.emojis.cache.values()].filter(
          (emoji) => emoji.guild.id !== currentGuildId,
        )
      : []),
  ];

  const usable = uniqueBy(
    candidates.filter(
      (emoji) =>
        emoji.available !== false &&
        canUseEmojiRoles(emoji) &&
        (emoji.guild.id === currentGuildId || allowExternal),
    ),
    (emoji) => emoji.id,
  );

  return sortByContextAndName(usable, currentGuildId, (emoji) => emoji.guild.id);
};

const sortUsableStickers = (items: ReadonlyArray<UsableSticker>, currentGuildId: string) =>
  [...items].sort((left, right) => {
    const leftContext = left.guildId === currentGuildId ? 0 : left.guildId !== null ? 1 : 2;
    const rightContext = right.guildId === currentGuildId ? 0 : right.guildId !== null ? 1 : 2;
    return (
      leftContext - rightContext ||
      left.sticker.name.localeCompare(right.sticker.name) ||
      left.sticker.id.localeCompare(right.sticker.id)
    );
  });

export const listUsableStickers = async (message: Message<true>): Promise<UsableSticker[]> => {
  const allowExternal =
    currentContextPermissions(message)?.has(PermissionFlagsBits.UseExternalStickers) ?? false;
  const currentGuildId = message.guild.id;
  const guildCandidates = [
    ...message.guild.stickers.cache.values(),
    ...(allowExternal
      ? [...message.client.guilds.cache.values()]
          .filter((guild) => guild.id !== currentGuildId)
          .flatMap((guild) => [...guild.stickers.cache.values()])
      : []),
  ];

  const standardCandidates = [...(await message.client.fetchStickerPacks()).values()].flatMap(
    (pack) =>
      [...pack.stickers.values()].map((sticker) => ({
        guildId: null,
        guildName: null,
        packName: pack.name,
        sticker,
      })),
  );

  const usable = uniqueBy(
    [
      ...guildCandidates
        .filter(
          (sticker) =>
            sticker.guildId !== null &&
            sticker.available !== false &&
            sticker.type === StickerType.Guild &&
            (sticker.guildId === currentGuildId || allowExternal),
        )
        .map((sticker) => ({
          guildId: sticker.guildId,
          guildName: sticker.guild?.name ?? null,
          packName: null,
          sticker,
        })),
      ...standardCandidates.filter(({ sticker }) => sticker.type === StickerType.Standard),
    ],
    ({ sticker }) => sticker.id,
  );

  return sortUsableStickers(usable, currentGuildId);
};
