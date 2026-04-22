import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
} from "@mariozechner/pi-coding-agent";

export interface PromptTemplateContext {
  readonly botName: string;
  readonly channelName: string;
  readonly guildName: string;
}

export interface ComposeSystemPromptInput {
  readonly botProfile: string;
  readonly discordContext: string;
  readonly includeWorkingDirectory: boolean;
  readonly systemPromptOptions: BuildSystemPromptOptions;
}

const PLACEHOLDER_PATTERN = /\{\{\s*(botName|channelName|guildName)\s*\}\}/g;

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

const formatGuidelinesSection = ({
  promptGuidelines,
}: BuildSystemPromptOptions): string | undefined => {
  const lines = [
    ...new Set((promptGuidelines ?? []).map((line) => line.trim()).filter(Boolean)),
  ].map((line) => `- ${line}`);

  return lines.length === 0 ? undefined : `Guidelines:\n${lines.join("\n")}`;
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

const currentDate = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
    `Current date: ${currentDate()}`,
    includeWorkingDirectory
      ? `Current working directory: ${systemPromptOptions.cwd.replaceAll("\\", "/")}`
      : undefined,
  ].filter((section): section is string => section !== undefined);

  return sections.join("\n\n");
};
