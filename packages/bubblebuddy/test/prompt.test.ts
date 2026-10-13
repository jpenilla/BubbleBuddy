import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type PromptInput } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";

import {
  createPromptSections,
  renderPromptTemplate,
  type SystemPromptInput,
} from "../src/pi/system-prompt.ts";

const promptContext = {
  botUsername: "bubblebuddy",
  botDisplayName: "Bubbles",
  channelName: "general",
  channelStatusText: "Open for coding",
  guildName: "Example",
};

// The sections render from what the prompt was built with, not the per-request input.
const renderSections = async (input: SystemPromptInput) =>
  new Map(
    await Promise.all(
      createPromptSections(input).map(
        async (section) =>
          [section.key, await section.render({} as PromptInput, BACKGROUND_CONTEXT)] as const,
      ),
    ),
  );

const input = (enableAgenticWorkspace: boolean): SystemPromptInput => ({
  botProfileTemplate: "Profile for {{botDisplayName}}",
  discordContextTemplate: "Discord section",
  promptContext: () => promptContext,
  enableAgenticWorkspace,
  cwd: "/workspace",
  resources: { contextFiles: [], skills: [] },
});

describe("prompt rendering", () => {
  test("renders the supported placeholders", () => {
    const rendered = renderPromptTemplate(
      "Bot={{botDisplayName}} Username={{botUsername}} Guild={{guildName}} Channel={{channelName}} Status={{channelStatusText}}",
      promptContext,
    );

    expect(rendered).toBe(
      "Bot=Bubbles Username=bubblebuddy Guild=Example Channel=general Status=Open for coding",
    );
  });

  test("renders the profile, discord context, and guidelines sections", async () => {
    const sections = await renderSections(input(false));

    expect(sections.get("profile")).toBe("Profile for Bubbles");
    expect(sections.get("discord")).toBe("Discord section");
    expect(sections.get("guidelines")).toContain(
      "- Use stay_silent when the user's message does not need a response.",
    );
    expect(sections.get("guidelines")).not.toContain("file attachments");
    expect(sections.get("date")).toMatch(/^Current date: /);
    expect(sections.get("cwd")).toBeUndefined();
  });

  test("includes the working directory and file guidance with the agentic workspace", async () => {
    const sections = await renderSections(input(true));

    expect(sections.get("cwd")).toBe("Current working directory: /workspace");
    expect(sections.get("guidelines")).toContain("file attachments");
  });
});
