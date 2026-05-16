import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { createChannelWorkspaceResourceLoader } from "../src/pi-session/workspace-resource-loader.ts";

describe("channel workspace resource loader", () => {
  let tempDir = "";
  let agentDir = "";
  let workspaceDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bubblebuddy-loader-"));
    agentDir = join(tempDir, "agent");
    workspaceDir = join(tempDir, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  const makeLoader = (enableAgenticWorkspace: boolean) =>
    createChannelWorkspaceResourceLoader({
      agentDir,
      appSkillPaths: [join(tempDir, "app", "skills")],
      enableAgenticWorkspace,
      extensionFactories: [],
      settingsManager: SettingsManager.create(workspaceDir, agentDir),
      workspaceDir,
    });

  test("loads only the channel workspace AGENTS.md", async () => {
    await writeFile(join(tempDir, "AGENTS.md"), "outer instructions\n", "utf8");
    await writeFile(join(workspaceDir, "AGENTS.md"), "inner\r\nworkspace\r\n", "utf8");

    const loader = makeLoader(true);
    await loader.reload();

    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      {
        content: "inner\nworkspace\n",
        path: "/workspace/AGENTS.md",
      },
    ]);
  });

  test("loads workspace-local skills without leaking ancestor scopes", async () => {
    await mkdir(join(workspaceDir, ".pi", "skills", "workspace-skill"), { recursive: true });
    await mkdir(join(tempDir, ".agents", "skills", "ancestor-skill"), { recursive: true });
    await writeFile(
      join(workspaceDir, ".pi", "skills", "workspace-skill", "SKILL.md"),
      ["---", "description: Use the workspace skill.", "---", "# Workspace Skill"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(tempDir, ".agents", "skills", "ancestor-skill", "SKILL.md"),
      ["---", "description: Use the ancestor skill.", "---", "# Ancestor Skill"].join("\n"),
      "utf8",
    );

    const loader = makeLoader(true);
    await loader.reload();

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["workspace-skill"]);
  });

  test("loads app-level skills when agentic workspace is off", async () => {
    await mkdir(join(tempDir, "app", "skills", "app-skill"), { recursive: true });
    await writeFile(join(workspaceDir, "AGENTS.md"), "workspace instructions\n", "utf8");
    await writeFile(
      join(tempDir, "app", "skills", "app-skill", "SKILL.md"),
      ["---", "description: Use the app skill.", "---", "# App Skill"].join("\n"),
      "utf8",
    );

    const loader = makeLoader(false);
    await loader.reload();

    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["app-skill"]);
  });

  test("loads workspace skills before app-level skills", async () => {
    await mkdir(join(workspaceDir, ".pi", "skills", "shared-skill"), { recursive: true });
    await mkdir(join(tempDir, "app", "skills", "shared-skill"), { recursive: true });
    await mkdir(join(tempDir, "app", "skills", "app-skill"), { recursive: true });
    await writeFile(
      join(workspaceDir, ".pi", "skills", "shared-skill", "SKILL.md"),
      ["---", "description: Use the workspace skill.", "---", "# Workspace Skill"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(tempDir, "app", "skills", "shared-skill", "SKILL.md"),
      ["---", "description: Use the app shared skill.", "---", "# App Shared Skill"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(tempDir, "app", "skills", "app-skill", "SKILL.md"),
      ["---", "description: Use the app skill.", "---", "# App Skill"].join("\n"),
      "utf8",
    );

    const loader = makeLoader(true);
    await loader.reload();

    const skills = loader.getSkills().skills;
    expect(skills.map((skill) => skill.name)).toEqual(["shared-skill", "app-skill"]);
    expect(skills[0]?.description).toBe("Use the workspace skill.");
  });
});
