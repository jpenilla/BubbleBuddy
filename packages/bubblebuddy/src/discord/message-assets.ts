import {
  type APIFileComponent,
  type APIMessageComponent,
  ButtonStyle,
  ComponentType,
  type Message,
  MessageReferenceType,
} from "discord.js";

import { sanitizeAttachmentFilename } from "../shared/workspace.ts";
import { type MessageContent } from "./message-content.ts";

export type MessageAsset = {
  readonly key: string;
  readonly url: string | undefined;
  readonly filename: string;
  readonly attachment: boolean;
  readonly forwarded: boolean;
};

export type MessageAssets = {
  readonly attachments: readonly {
    readonly key: string;
    readonly name: string;
    readonly size: number;
  }[];
  readonly embeds: readonly string[];
  readonly components: readonly string[];
};

export const collectMessageAssets = (message: Message<true>) => {
  const assets: MessageAsset[] = [];
  const collectContent = (content: MessageContent, forwarded: boolean): MessageAssets => {
    const attachmentKeys = new Map<string, string>();
    const add = (url: string | undefined, filename: string, attachment = false): string => {
      const key = `a${assets.length + 1}`;
      assets.push({ key, url, filename, attachment, forwarded });
      return key;
    };

    const attachments = [...content.attachments.values()].map((attachment) => {
      const filename = sanitizeAttachmentFilename(attachment.name);
      const key = add(attachment.url, filename, true);
      // In our duplicate-name probe Discord resolved the file component to the last upload;
      // this is observed behavior, not a documented guarantee.
      attachmentKeys.set(attachment.name, key);
      return { key, name: filename, size: attachment.size };
    });

    const embedMedia = (
      value: { url?: string; proxy_url?: string; width?: number; height?: number } | undefined,
      filename: string,
    ) => {
      if (value === undefined) return undefined;
      const url = value.proxy_url ?? value.url;
      return {
        asset: add(url, filename),
        ...(value.width == null ? {} : { width: value.width }),
        ...(value.height == null ? {} : { height: value.height }),
      };
    };

    const embeds = content.embeds.map((embed) => {
      const { author, footer, image, thumbnail, video, ...content } = embed.toJSON();
      const authorIcon = author?.icon_url
        ? { asset: add(embed.author?.proxyIconURL ?? author.icon_url, "author-icon") }
        : undefined;
      const footerIcon = footer?.icon_url
        ? { asset: add(embed.footer?.proxyIconURL ?? footer.icon_url, "footer-icon") }
        : undefined;
      return JSON.stringify(
        {
          ...content,
          author:
            author === undefined
              ? undefined
              : { name: author.name, url: author.url, icon: authorIcon },
          footer: footer === undefined ? undefined : { text: footer.text, icon: footerIcon },
          image: embedMedia(
            image === undefined ? undefined : { ...image, proxy_url: embed.image?.proxyURL },
            "image",
          ),
          thumbnail: embedMedia(
            thumbnail === undefined
              ? undefined
              : { ...thumbnail, proxy_url: embed.thumbnail?.proxyURL },
            "thumbnail",
          ),
          video: embedMedia(
            video === undefined ? undefined : { ...video, proxy_url: embed.video?.proxyURL },
            "video",
          ),
        },
        undefined,
        2,
      );
    });

    const componentMedia = (value: APIFileComponent["file"], filename: string) => {
      const rawUrl = value.url;
      const attachmentName = rawUrl.startsWith("attachment://")
        ? rawUrl.slice("attachment://".length)
        : undefined;
      const key = attachmentName === undefined ? undefined : attachmentKeys.get(attachmentName);
      const url = value.proxy_url ?? (attachmentName === undefined ? rawUrl : undefined);
      return {
        asset: key ?? add(url, filename),
        ...(value.width == null ? {} : { width: value.width }),
        ...(value.height == null ? {} : { height: value.height }),
        ...(value.content_type == null ? {} : { content_type: value.content_type }),
      };
    };

    const formatComponent = (component: APIMessageComponent): object | undefined => {
      const type = ComponentType[component.type].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      switch (component.type) {
        case ComponentType.Container:
          return {
            type,
            components: component.components
              .map(formatComponent)
              .filter((child) => child !== undefined),
            ...(component.spoiler ? { spoiler: true } : {}),
          };
        case ComponentType.ActionRow:
          return { type, components: component.components.map(formatComponent) };
        case ComponentType.Section:
          return {
            type,
            components: component.components.map(formatComponent),
            accessory: formatComponent(component.accessory),
          };
        case ComponentType.TextDisplay:
          return { type, content: component.content };
        case ComponentType.MediaGallery:
          return {
            type,
            items: component.items.map((item) => ({
              ...(item.description ? { description: item.description } : {}),
              ...(item.spoiler ? { spoiler: true } : {}),
              media: componentMedia(item.media, "gallery-item"),
            })),
          };
        case ComponentType.Thumbnail:
          return {
            type,
            media: componentMedia(component.media, "media"),
            ...(component.description ? { description: component.description } : {}),
            ...(component.spoiler ? { spoiler: true } : {}),
          };
        case ComponentType.File:
          return {
            type,
            file: componentMedia(component.file, "file"),
            ...(component.name ? { name: component.name } : {}),
            ...(component.spoiler ? { spoiler: true } : {}),
          };
        case ComponentType.Button:
          return {
            type,
            style: ButtonStyle[component.style].toLowerCase(),
            ...("label" in component && component.label ? { label: component.label } : {}),
            ...("emoji" in component && component.emoji ? { emoji: component.emoji } : {}),
            ...("url" in component ? { url: component.url } : {}),
            ...(component.disabled ? { disabled: true } : {}),
          };
        case ComponentType.StringSelect:
          return {
            type,
            ...(component.placeholder ? { placeholder: component.placeholder } : {}),
            options: component.options.map((option) => ({
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
              ...(option.emoji ? { emoji: option.emoji } : {}),
            })),
            ...(component.disabled ? { disabled: true } : {}),
          };
        case ComponentType.UserSelect:
        case ComponentType.RoleSelect:
        case ComponentType.MentionableSelect:
        case ComponentType.ChannelSelect:
          return {
            type,
            ...(component.placeholder ? { placeholder: component.placeholder } : {}),
            ...(component.disabled ? { disabled: true } : {}),
          };
        case ComponentType.Separator:
          return undefined;
        default: {
          const remaining: never = component;
          return remaining;
        }
      }
    };

    const components = content.components
      .map((component) => formatComponent(component.toJSON()))
      .filter((component) => component !== undefined)
      .map((component) => JSON.stringify(component, undefined, 2));
    return { attachments, embeds, components };
  };

  const main = collectContent(message, false);
  const snapshot =
    message.reference?.type === MessageReferenceType.Forward
      ? message.messageSnapshots.first()
      : undefined;
  const forwarded = snapshot === undefined ? undefined : collectContent(snapshot, true);
  return { main, forwarded, catalog: assets };
};
