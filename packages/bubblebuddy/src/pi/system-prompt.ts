import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { DateTime } from "effect";

export interface PromptTemplateContext {
  readonly botName: string;
  readonly channelName: string;
  readonly channelStatusText: string;
  readonly guildName: string;
}

export interface ComposeSystemPromptInput {
  readonly botProfile: string;
  readonly discordContext: string;
  readonly includeWorkingDirectory: boolean;
  readonly systemPromptOptions: BuildSystemPromptOptions;
}

const PLACEHOLDER_PATTERN = /\{\{\s*(botName|channelName|channelStatusText|guildName)\s*\}\}/g;

const DISCORD_GUIDELINES = [
  "Transcript users have mention=<@id>; copy it exactly to ping them. @name is plain text only.",
  "Ordinary assistant text is streamed into new messages and automatically split across as many messages as needed; it does not need to fit in a single Discord message.",
  "For tools that support terminate, set terminate=true when the action completes your response; use false when continuing. Early termination only applies when every tool call in the same batch succeeds and returns terminate=true. Terminating calls may be batched across different tools.",
  "Treat times and timezones as context-dependent: don’t mistake a timestamp’s timezone for a person’s, and clarify local-time assumptions when they matter.",
];

const normalizeSection = (value: string): string | undefined => {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const formatAvailableToolsSection = ({
  selectedTools,
  toolSnippets,
}: BuildSystemPromptOptions): string | undefined => {
  const lines = (selectedTools ?? [])
    .map((toolName) => {
      const snippet = toolSnippets?.[toolName]?.trim();
      return snippet === undefined || snippet.length === 0
        ? undefined
        : `- ${toolName}: ${snippet}`;
    })
    .filter((line): line is string => line !== undefined);

  return lines.length === 0 ? undefined : `Available tools:\n${lines.join("\n")}`;
};

const formatGuidelinesSection = ({ promptGuidelines }: BuildSystemPromptOptions): string => {
  const guidelines = [...DISCORD_GUIDELINES, ...(promptGuidelines ?? [])];
  const normalizedGuidelines = guidelines.map((line) => line.trim()).filter(Boolean);
  const uniqueGuidelines = [...new Set(normalizedGuidelines)];
  const lines = uniqueGuidelines.map((line) => `- ${line}`);

  return `Guidelines:\n${lines.join("\n")}`;
};

const formatContextFilesSection = ({
  contextFiles,
}: BuildSystemPromptOptions): string | undefined => {
  if (contextFiles === undefined || contextFiles.length === 0) {
    return undefined;
  }

  const sections = contextFiles.map(({ path, content }) => `## ${path}\n\n${content.trim()}`);

  return `# Project Context\n\nProject-specific instructions and guidelines:\n\n${sections.join("\n\n")}`;
};

export const renderPromptTemplate = (template: string, context: PromptTemplateContext): string =>
  template.replaceAll(PLACEHOLDER_PATTERN, (_, key: keyof PromptTemplateContext) => context[key]);

export const composeSystemPrompt = ({
  botProfile,
  discordContext,
  includeWorkingDirectory,
  systemPromptOptions,
}: ComposeSystemPromptInput): string => {
  const sections = [
    normalizeSection(botProfile),
    normalizeSection(discordContext),
    formatAvailableToolsSection(systemPromptOptions),
    formatGuidelinesSection(systemPromptOptions),
    formatContextFilesSection(systemPromptOptions),
    systemPromptOptions.skills?.length
      ? normalizeSection(formatSkillsForPrompt(systemPromptOptions.skills))
      : undefined,
    `Current date: ${DateTime.formatIsoDateUtc(DateTime.nowUnsafe())}`,
    includeWorkingDirectory
      ? `Current working directory: ${systemPromptOptions.cwd.replaceAll("\\", "/")}`
      : undefined,
  ].filter((section): section is string => section !== undefined);

  return sections.join("\n\n");
};
