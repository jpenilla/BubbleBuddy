import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DefaultResourceLoader,
  type ExtensionFactory,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { WORKSPACE_CWD } from "./workspace.ts";

export interface ChannelWorkspaceResourceLoaderOptions {
  readonly agentDir: string;
  readonly enableAgenticWorkspace: boolean;
  readonly extensionFactories: ExtensionFactory[];
  readonly settingsManager: SettingsManager;
  readonly workspaceDir: string;
}

const normalizeLineEndings = (value: string): string => value.replaceAll("\r\n", "\n");

const readWorkspaceAgentsFile = (
  workspaceDir: string,
): Array<{ path: string; content: string }> => {
  try {
    const content = normalizeLineEndings(readFileSync(join(workspaceDir, "AGENTS.md"), "utf8"));
    return [
      {
        content,
        path: `${WORKSPACE_CWD}/AGENTS.md`,
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

const workspaceSkillPaths = (workspaceDir: string): string[] => [
  join(workspaceDir, ".pi", "skills"),
  join(workspaceDir, ".agents", "skills"),
];

export const createChannelWorkspaceResourceLoader = (
  options: ChannelWorkspaceResourceLoaderOptions,
): ResourceLoader =>
  new DefaultResourceLoader({
    additionalSkillPaths: options.enableAgenticWorkspace
      ? workspaceSkillPaths(options.workspaceDir)
      : [],
    agentDir: options.agentDir,
    agentsFilesOverride: () => ({
      agentsFiles: options.enableAgenticWorkspace
        ? readWorkspaceAgentsFile(options.workspaceDir)
        : [],
    }),
    appendSystemPromptOverride: () => [],
    cwd: options.workspaceDir,
    extensionFactories: options.extensionFactories,
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: options.settingsManager,
    systemPromptOverride: () => undefined,
  });
