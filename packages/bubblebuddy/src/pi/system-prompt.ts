import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { section, type PromptSection } from "@earendil-works/pi-durable";
import { DateTime } from "effect";

import { type WorkspaceResources } from "./workspace-resources.ts";

export interface PromptTemplateContext {
  readonly botUsername: string;
  readonly botDisplayName: string;
  readonly channelName: string;
  readonly channelStatusText: string;
  readonly guildName: string;
}

export interface SystemPromptInput {
  readonly botProfileTemplate: string;
  readonly discordContextTemplate: string;
  readonly promptContext: () => PromptTemplateContext;
  readonly enableAgenticWorkspace: boolean;
  readonly cwd: string;
  readonly resources: WorkspaceResources;
}

const PLACEHOLDER_PATTERN =
  /\{\{\s*(botUsername|botDisplayName|channelName|channelStatusText|guildName)\s*\}\}/g;

const DISCORD_GUIDELINES = [
  "Transcript [ping ...] entries represent pings, whether full or short. To ping someone in your reply, use <@id> with their user_id from a full ping or message sender; plain names do not ping.",
  "Ordinary assistant text is streamed into new messages and automatically split across as many messages as needed; it does not need to fit in a single Discord message.",
  "For tools that support terminate, set terminate=true when the action completes your response; use false when continuing. Early termination only applies when every tool call in the same batch succeeds and returns terminate=true. Terminating calls may be batched across different tools.",
  "Treat times and timezones as context-dependent: don’t mistake a timestamp’s timezone for a person’s, and clarify local-time assumptions when they matter.",
];

const toolGuidelines = (enableFiles: boolean) => [
  enableFiles
    ? "discord_send adds Discord-specific delivery options: a reply reference with optional author notification, stickers, and file attachments."
    : "discord_send adds Discord-specific delivery options: a reply reference with optional author notification and stickers.",
  enableFiles
    ? "A discord_send call with stickers or files is a single message, so keep its text within the character limit; text-only replies may be any length and are split automatically."
    : "A discord_send call with stickers is a single message, so keep its text within the character limit; text-only replies may be any length and are split automatically.",
  "Use discord_send during a turn as needed. For a send that completes the response, include any closing text in content.",
  "Use stay_silent when the user's message does not need a response. It must be called in its own tool-call batch.",
  "When a message replies to or otherwise references a message ID you do not recognize, you may attempt to fetch it",
];

const normalizeSection = (value: string): string | undefined => {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const formatGuidelinesSection = (enableAgenticWorkspace: boolean): string =>
  `Guidelines:\n${[...DISCORD_GUIDELINES, ...toolGuidelines(enableAgenticWorkspace)]
    .map((line) => `- ${line}`)
    .join("\n")}`;

const formatContextFilesSection = (
  contextFiles: WorkspaceResources["contextFiles"],
): string | undefined => {
  if (contextFiles.length === 0) {
    return undefined;
  }

  const sections = contextFiles.map(({ path, content }) => `## ${path}\n\n${content.trim()}`);

  return `# Project Context\n\nProject-specific instructions and guidelines:\n\n${sections.join("\n\n")}`;
};

export const renderPromptTemplate = (template: string, context: PromptTemplateContext): string =>
  template.replaceAll(PLACEHOLDER_PATTERN, (_, key: keyof PromptTemplateContext) => context[key]);

/** The system prompt as pi-durable sections, rendered in order before each request; `undefined` omits a section. */
export const createPromptSections = (input: SystemPromptInput): PromptSection[] => [
  section(
    "profile",
    () => normalizeSection(renderPromptTemplate(input.botProfileTemplate, input.promptContext())),
    { tag: false },
  ),
  section(
    "discord",
    () =>
      normalizeSection(renderPromptTemplate(input.discordContextTemplate, input.promptContext())),
    { tag: false },
  ),
  section("guidelines", () => formatGuidelinesSection(input.enableAgenticWorkspace), {
    tag: false,
  }),
  section("project_context", () => formatContextFilesSection(input.resources.contextFiles), {
    tag: false,
  }),
  section(
    "skills",
    () =>
      input.resources.skills.length > 0
        ? normalizeSection(formatSkillsForPrompt([...input.resources.skills]))
        : undefined,
    { tag: false },
  ),
  section("date", () => `Current date: ${DateTime.formatIsoDateUtc(DateTime.nowUnsafe())}`, {
    tag: false,
  }),
  section(
    "cwd",
    () =>
      input.enableAgenticWorkspace
        ? `Current working directory: ${input.cwd.replaceAll("\\", "/")}`
        : undefined,
    { tag: false },
  ),
];
