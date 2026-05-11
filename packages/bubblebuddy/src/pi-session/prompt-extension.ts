import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  composeSystemPrompt,
  renderPromptTemplate,
  type PromptTemplateContext,
} from "../prompt/system-prompt.ts";

export interface PromptComposerExtensionOptions {
  readonly botProfile: string;
  readonly discordContextTemplate: string;
  readonly enableAgenticWorkspace: boolean;
  readonly promptContext: PromptTemplateContext;
}

export const createPromptComposerExtension = (
  options: PromptComposerExtensionOptions,
): ExtensionFactory => {
  const botProfile = renderPromptTemplate(options.botProfile, options.promptContext);
  const discordContext = renderPromptTemplate(
    options.discordContextTemplate,
    options.promptContext,
  );

  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event) => ({
      systemPrompt: composeSystemPrompt({
        botProfile,
        discordContext,
        includeWorkingDirectory: options.enableAgenticWorkspace,
        systemPromptOptions: event.systemPromptOptions,
      }),
    }));
  };
};
