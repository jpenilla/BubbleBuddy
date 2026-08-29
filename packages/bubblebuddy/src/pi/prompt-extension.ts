import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  composeSystemPrompt,
  renderPromptTemplate,
  type PromptTemplateContext,
} from "./system-prompt.ts";

export interface CreatePromptComposerExtensionInput {
  readonly botProfile: string;
  readonly discordContextTemplate: string;
  readonly enableAgenticWorkspace: boolean;
  readonly promptContext: PromptTemplateContext;
}

export const createPromptComposerExtension = (
  input: CreatePromptComposerExtensionInput,
): ExtensionFactory => {
  const botProfile = renderPromptTemplate(input.botProfile, input.promptContext);
  const discordContext = renderPromptTemplate(input.discordContextTemplate, input.promptContext);

  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event) => ({
      systemPrompt: composeSystemPrompt({
        botProfile,
        discordContext,
        includeWorkingDirectory: input.enableAgenticWorkspace,
        systemPromptOptions: event.systemPromptOptions,
      }),
    }));
  };
};
