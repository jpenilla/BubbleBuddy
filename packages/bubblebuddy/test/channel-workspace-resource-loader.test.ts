import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Path } from "effect";

import { createMountedWorkspace } from "../src/shared/workspace.ts";
import { createChannelWorkspaceResourceLoader } from "../src/pi/workspace-resource-loader.ts";

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

  // A container root distinct from the production WORKSPACE_CWD constant, so
  // these tests fail if the loader falls back to the constant instead of the
  // workspace it was given.
  const containerRoot = "/scope-root";

  const workspace = () =>
    Effect.runSync(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return createMountedWorkspace(path, workspaceDir, containerRoot);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  const createLoader = (enableAgenticWorkspace: boolean) =>
    createChannelWorkspaceResourceLoader({
      agentDir,
      enableAgenticWorkspace,
      extensionFactories: [],
      settingsManager: SettingsManager.create(workspaceDir, agentDir),
      workspace: workspace(),
    });

  test("loads only the channel workspace AGENTS.md", async () => {
    await writeFile(join(tempDir, "AGENTS.md"), "outer instructions\n", "utf8");
    await writeFile(join(workspaceDir, "AGENTS.md"), "inner\r\nworkspace\r\n", "utf8");

    const loader = createLoader(true);
    await loader.reload();

    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      {
        content: "inner\nworkspace\n",
        path: "/scope-root/AGENTS.md",
      },
    ]);
  });

  test("loads workspace-local skills without leaking ancestor scopes", async () => {
    await mkdir(join(workspaceDir, ".pi", "skills", "workspace-skill"), { recursive: true });
    await mkdir(join(tempDir, ".agents", "skills", "ancestor-skill"), { recursive: true });
    await writeFile(
      join(workspaceDir, ".pi", "skills", "workspace-skill", "SKILL.md"),
      ["---", "description: Use the workspace skill.", "---", "# Workspace Skill"].join("\n"),
    );
    await writeFile(
      join(tempDir, ".agents", "skills", "ancestor-skill", "SKILL.md"),
      ["---", "description: Use the ancestor skill.", "---", "# Ancestor Skill"].join("\n"),
    );

    const loader = createLoader(true);
    await loader.reload();

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["workspace-skill"]);
  });

  test("omits workspace context when agentic workspace is off", async () => {
    await writeFile(join(workspaceDir, "AGENTS.md"), "workspace instructions\n", "utf8");

    const loader = createLoader(false);
    await loader.reload();

    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
  });
});
