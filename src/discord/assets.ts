import {
  PermissionFlagsBits,
  StickerType,
  parseEmoji,
  type Client,
  type Guild,
  type GuildEmoji,
  type GuildTextBasedChannel,
  type Sticker,
} from "discord.js";

export type DiscordAssetContext = {
  readonly channel: GuildTextBasedChannel;
  readonly client: Client<true>;
  readonly guild: Guild;
};

export type UsableSticker = {
  readonly guildId: string | null;
  readonly guildName: string | null;
  readonly packName: string | null;
  readonly sticker: Sticker;
};

const currentContextPermissions = (context: DiscordAssetContext) =>
  context.channel.permissionsFor(context.client.user);

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

export const formatCustomEmojiMessageSyntax = (emoji: GuildEmoji): string =>
  `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;

export const formatCustomEmojiReactionSyntax = (emoji: GuildEmoji): string =>
  `${emoji.animated ? "a:" : ""}${emoji.name}:${emoji.id}`;

export const listUsableCustomEmojis = (context: DiscordAssetContext): GuildEmoji[] => {
  const allowExternal =
    currentContextPermissions(context)?.has(PermissionFlagsBits.UseExternalEmojis) ?? false;
  const currentGuildId = context.guild.id;
  const candidates = [
    ...context.guild.emojis.cache.values(),
    ...(allowExternal
      ? [...context.client.emojis.cache.values()].filter(
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

export const normalizeReactionEmoji = (
  context: DiscordAssetContext,
  input: string,
): string | null => {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const customEmojiById = new Map(
    listUsableCustomEmojis(context).map((emoji) => [emoji.id, emoji]),
  );
  const aliasMatch = trimmed.match(/^:([A-Za-z0-9_]{2,32}):$/);
  if (aliasMatch) {
    const alias = aliasMatch[1]!.toLowerCase();
    const matches = [...customEmojiById.values()].filter(
      (emoji) => emoji.name.toLowerCase() === alias,
    );
    if (matches.length !== 1) {
      return null;
    }
    return formatCustomEmojiReactionSyntax(matches[0]!);
  }

  const parsed = parseEmoji(trimmed);
  if (parsed?.id) {
    const match = customEmojiById.get(parsed.id);
    if (!match) {
      return null;
    }
    return formatCustomEmojiReactionSyntax(match);
  }

  return trimmed;
};

export const listUsableStickers = async (
  context: DiscordAssetContext,
): Promise<UsableSticker[]> => {
  const allowExternal =
    currentContextPermissions(context)?.has(PermissionFlagsBits.UseExternalStickers) ?? false;
  const currentGuildId = context.guild.id;
  const guildCandidates = [
    ...context.guild.stickers.cache.values(),
    ...(allowExternal
      ? [...context.client.guilds.cache.values()]
          .filter((guild) => guild.id !== currentGuildId)
          .flatMap((guild) => [...guild.stickers.cache.values()])
      : []),
  ];

  const standardCandidates = [...(await context.client.fetchStickerPacks()).values()].flatMap(
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
