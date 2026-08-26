import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/infrastructure/git-client.js";
import { ConfigService } from "../src/services/config-service.js";
import { WorkspaceService } from "../src/services/workspace-service.js";
import { WorktreeService } from "../src/services/worktree-service.js";
import { WorktreeWorkflowService } from "../src/services/worktree-workflow-service.js";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

describe("configured worktree workflows", () => {
  let temporaryRoot: string;
  let repository: TestRepository;
  let git: GitClient;
  let configs: ConfigService;
  let workspaces: WorkspaceService;
  let worktrees: WorktreeService;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wt-workflow-test-"));
    repository = await createTestRepository(temporaryRoot);
    git = new GitClient();
    configs = new ConfigService();
    workspaces = new WorkspaceService(git, configs);
    worktrees = new WorktreeService(git);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("requires trust, then runs lifecycle hooks, file steps, and named tasks", async () => {
    await commitProjectConfig(
      repository,
      `version: 1
defaults:
  fetch: false
hooks:
  pre_create:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync(process.env.WT_WORKSPACE_ROOT + '/pre-create.log', process.env.WT_BRANCH)"]
      cwd: workspace
  post_create:
    - type: copy
      source: default
      from: config.example
      to: config.local
    - type: symlink
      source: default
      from: shared.txt
      to: linked-shared.txt
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('post-create.log', process.env.WT_EVENT)"]
  pre_remove:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync(process.env.WT_WORKSPACE_ROOT + '/pre-remove.log', process.env.WT_BRANCH)"]
  post_remove:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('post-remove.log', process.env.WT_EVENT)"]
      cwd: workspace
tasks:
  verify:
    description: Run the project check
    steps:
      - type: command
        argv: [node, -e, "require('node:fs').writeFileSync('task.log', process.env.WT_EVENT)"]
`,
      {
        "config.example": "EXAMPLE=true\n",
        "shared.txt": "shared\n",
      },
    );
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "workspace"),
    );
    const workflow = new WorktreeWorkflowService(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, { branch: "main" });

    expect(plan.trusted).toBe(false);
    await expect(workflow.executeCreate(plan)).rejects.toThrow(/not trusted/u);
    expect(await worktrees.list(workspace)).toEqual([]);

    if (!plan.project) throw new Error("Expected project configuration.");
    await configs.trust(workspace, plan.project);
    const created = await workflow.executeCreate(plan);

    expect(await fs.readFile(path.join(workspace.root, "pre-create.log"), "utf8")).toBe("main");
    expect(await fs.readFile(path.join(created.path, "config.local"), "utf8")).toBe(
      "EXAMPLE=true\n",
    );
    expect(await fs.readlink(path.join(created.path, "linked-shared.txt"))).toBe("shared.txt");
    expect(await fs.readFile(path.join(created.path, "post-create.log"), "utf8")).toBe(
      "post_create",
    );

    await workflow.runTask(workspace, created, "verify");
    expect(await fs.readFile(path.join(created.path, "task.log"), "utf8")).toBe("task:verify");

    for (const generated of ["config.local", "linked-shared.txt", "post-create.log", "task.log"]) {
      await fs.rm(path.join(created.path, generated), { force: true });
    }
    const removal = await workflow.planRemove(workspace, created.name);
    await workflow.executeRemove(removal);

    expect(await fs.readFile(path.join(workspace.root, "pre-remove.log"), "utf8")).toBe("main");
    expect(await fs.readFile(path.join(workspace.root, "post-remove.log"), "utf8")).toBe(
      "post_remove",
    );
    expect(await worktrees.list(workspace)).toEqual([]);
  });

  it("keeps a created worktree when post-create setup fails", async () => {
    await commitProjectConfig(
      repository,
      `version: 1
hooks:
  post_create:
    - type: command
      shell: |
        exit 23
`,
    );
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "failed-workspace"),
    );
    const workflow = new WorktreeWorkflowService(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, { branch: "main", fetch: false });
    if (!plan.project) throw new Error("Expected project configuration.");
    await configs.trust(workspace, plan.project);

    await expect(workflow.executeCreate(plan)).rejects.toThrow(
      /Worktree was created[\s\S]*Retry with: wt setup/u,
    );
    await expect(worktrees.resolve(workspace, "main")).resolves.toMatchObject({ branch: "main" });
  });
});

async function commitProjectConfig(
  repository: TestRepository,
  configuration: string,
  files: Record<string, string> = {},
): Promise<void> {
  await fs.writeFile(path.join(repository.source, ".wt.yml"), configuration, "utf8");
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(repository.source, name), content, "utf8");
  }
  await gitRun(repository.source, ["add", ".wt.yml", ...Object.keys(files)]);
  await gitRun(repository.source, ["commit", "-m", "add wt workflow"]);
  await gitRun(repository.source, ["push", "origin", "main"]);
}

async function gitRun(cwd: string, args: string[]): Promise<void> {
  await new GitClient().run(args, { cwd });
}
