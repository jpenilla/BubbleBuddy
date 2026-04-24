import { describe, expect, test } from "bun:test";

import { composeSystemPrompt, renderPromptTemplate } from "../src/domain/prompt.ts";

describe("prompt rendering", () => {
  test("renders the supported placeholders", () => {
    const rendered = renderPromptTemplate(
      "Bot={{botName}} Guild={{guildName}} Channel={{channelName}} Status={{channelStatusText}}",
      {
        botName: "bubblebuddy",
        channelName: "general",
        channelStatusText: "Open for coding",
        guildName: "Example",
      },
    );

    expect(rendered).toBe("Bot=bubblebuddy Guild=Example Channel=general Status=Open for coding");
  });

  test("composes a system prompt from profile, discord context, and tool metadata", () => {
    const prompt = composeSystemPrompt({
      botProfile: "Profile section",
      discordContext: "Discord section",
      includeWorkingDirectory: false,
      systemPromptOptions: {
        cwd: "/workspace",
        promptGuidelines: ["Use discord_lookup when the user asks about prior messages."],
        selectedTools: ["discord_lookup"],
        toolSnippets: {
          discord_lookup: "Look up prior Discord messages",
        },
      },
    });

    expect(prompt).toContain("Profile section");
    expect(prompt).toContain("Discord section");
    expect(prompt).toContain("Available tools:\n- discord_lookup: Look up prior Discord messages");
    expect(prompt).toContain(
      "Guidelines:\n- Use discord_lookup when the user asks about prior messages.",
    );
    expect(prompt).toContain("Current date: ");
    expect(prompt).not.toContain("Current working directory:");
  });

  test("includes the working directory when requested", () => {
    const prompt = composeSystemPrompt({
      botProfile: "Profile section",
      discordContext: "Discord section",
      includeWorkingDirectory: true,
      systemPromptOptions: {
        cwd: "/workspace",
      },
    });

    expect(prompt).toContain("Current working directory: /workspace");
  });
});
