import { readFileSync } from "node:fs";

import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";

import { normalizeLineEndings } from "../shared/text.ts";
import { type MountedWorkspace } from "../shared/workspace.ts";

export interface WorkspaceResources {
  readonly contextFiles: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly skills: readonly Skill[];
}

export interface LoadWorkspaceResourcesInput {
  readonly agentDir: string;
  readonly enableAgenticWorkspace: boolean;
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

// Host paths: loadSkills reads these with host fs.
// formatSkillsForPrompt dumps skill.filePath into <location>, so the model
// still sees host paths. Remap at prompt compose time; do not rewrite Skill.filePath
// (Pi still readFileSyncs it).
const workspaceSkillPaths = (workspace: MountedWorkspace): string[] => [
  workspace.resolve(".pi", "skills").host,
  workspace.resolve(".agents", "skills").host,
];

/** The channel workspace's AGENTS.md and skills; none without the agentic workspace. */
export const loadWorkspaceResources = (input: LoadWorkspaceResourcesInput): WorkspaceResources =>
  input.enableAgenticWorkspace
    ? {
        contextFiles: readWorkspaceAgentsFile(input.workspace),
        skills: loadSkills({
          cwd: input.workspace.root.host,
          agentDir: input.agentDir,
          skillPaths: workspaceSkillPaths(input.workspace),
          includeDefaults: false,
        }).skills,
      }
    : { contextFiles: [], skills: [] };
