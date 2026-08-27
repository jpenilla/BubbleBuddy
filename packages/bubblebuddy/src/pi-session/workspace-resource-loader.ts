import { readFileSync } from "node:fs";

import {
  DefaultResourceLoader,
  type ExtensionFactory,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { MountedWorkspace } from "../shared/workspace.ts";
import { normalizeLineEndings } from "../shared/text.ts";

export interface ChannelWorkspaceResourceLoaderOptions {
  readonly agentDir: string;
  readonly enableAgenticWorkspace: boolean;
  readonly extensionFactories: ExtensionFactory[];
  readonly settingsManager: SettingsManager;
  readonly workspace: MountedWorkspace;
}

const readWorkspaceAgentsFile = (
  workspace: MountedWorkspace,
): Array<{ path: string; content: string }> => {
  const agentsFile = workspace.resolve("AGENTS.md");
  try {
    const content = normalizeLineEndings(readFileSync(agentsFile.host, "utf8"));
    return [
      {
        content,
        path: agentsFile.container,
      },
    ];
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return [];
    }

    throw error;
  }
};

// Host paths: Pi's loader reads these with host fs.
// formatSkillsForPrompt dumps skill.filePath into <location>, so the model
// still sees host paths. Remap at prompt compose time; do not rewrite Skill.filePath
// (Pi still readFileSyncs it).
const workspaceSkillPaths = (workspace: MountedWorkspace): string[] => [
  workspace.resolve(".pi", "skills").host,
  workspace.resolve(".agents", "skills").host,
];

export const createChannelWorkspaceResourceLoader = (
  options: ChannelWorkspaceResourceLoaderOptions,
): ResourceLoader =>
  new DefaultResourceLoader({
    additionalSkillPaths: options.enableAgenticWorkspace
      ? workspaceSkillPaths(options.workspace)
      : [],
    agentDir: options.agentDir,
    agentsFilesOverride: () => ({
      agentsFiles: options.enableAgenticWorkspace ? readWorkspaceAgentsFile(options.workspace) : [],
    }),
    appendSystemPromptOverride: () => [],
    cwd: options.workspace.root.host,
    extensionFactories: options.extensionFactories,
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: options.settingsManager,
    systemPromptOverride: () => undefined,
  });
