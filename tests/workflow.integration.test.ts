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

  it("links and copies workspace-local shared files without escaping the shared root", async () => {
    await commitProjectConfig(
      repository,
      `version: 1
defaults:
  fetch: false
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env
    - type: symlink
      source: shared
      from: env/apps/api/.env
      to: apps/api/.env
    - type: copy
      source: shared
      from: config/tool.json
      to: .local/tool.json
tasks:
  sync-local:
    steps:
      - type: copy
        source: shared
        from: config/tool.json
        to: .local/tool.json
        overwrite: true
  escape:
    steps:
      - type: copy
        source: shared
        from: escape
        to: escaped.txt
  traversal:
    steps:
      - type: copy
        source: shared
        from: ../outside-secret
        to: escaped.txt
  optional-local:
    steps:
      - type: copy
        source: shared
        from: missing.txt
        to: optional.txt
        optional: true
`,
    );
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "shared-workspace"),
    );
    await fs.mkdir(path.join(workspace.sharedDir, "env", "apps", "api"), { recursive: true });
    await fs.mkdir(path.join(workspace.sharedDir, "config"), { recursive: true });
    await fs.writeFile(path.join(workspace.sharedDir, "env", ".env"), "ROOT=true\n", "utf8");
    await fs.writeFile(
      path.join(workspace.sharedDir, "env", "apps", "api", ".env"),
      "API=true\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace.sharedDir, "config", "tool.json"),
      '{"version":1}\n',
      "utf8",
    );

    const workflow = new WorktreeWorkflowService(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, { branch: "main", fetch: false });
    if (!plan.project) throw new Error("Expected project configuration.");
    await configs.trust(workspace, plan.project);
    const created = await workflow.executeCreate(plan);

    const rootLink = await fs.readlink(path.join(created.path, ".env"));
    expect(path.isAbsolute(rootLink)).toBe(false);
    expect(await fs.readFile(path.join(created.path, ".env"), "utf8")).toBe("ROOT=true\n");
    expect(await fs.readFile(path.join(created.path, "apps", "api", ".env"), "utf8")).toBe(
      "API=true\n",
    );
    expect(await fs.readFile(path.join(created.path, ".local", "tool.json"), "utf8")).toBe(
      '{"version":1}\n',
    );
    await expect(workflow.runHook(workspace, created, "post_create")).rejects.toThrow(
      /Target path already exists/u,
    );
    await workflow.runTask(workspace, created, "optional-local");
    await expect(fs.stat(path.join(created.path, "optional.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(workflow.runTask(workspace, created, "traversal")).rejects.toThrow(
      /Source path must stay inside its configured source/u,
    );

    await fs.writeFile(
      path.join(workspace.sharedDir, "config", "tool.json"),
      '{"version":2}\n',
      "utf8",
    );
    await workflow.runTask(workspace, created, "sync-local");
    expect(await fs.readFile(path.join(created.path, ".local", "tool.json"), "utf8")).toBe(
      '{"version":2}\n',
    );

    const outside = path.join(temporaryRoot, "outside-secret");
    await fs.writeFile(outside, "do not copy\n", "utf8");
    await fs.symlink(outside, path.join(workspace.sharedDir, "escape"));
    await expect(workflow.runTask(workspace, created, "escape")).rejects.toThrow(
      /Source path resolves outside/u,
    );

    const outsideShared = path.join(temporaryRoot, "outside-shared");
    await fs.mkdir(path.join(outsideShared, "config"), { recursive: true });
    await fs.writeFile(
      path.join(outsideShared, "config", "tool.json"),
      '{"outside":true}\n',
      "utf8",
    );
    await fs.rm(workspace.sharedDir, { recursive: true });
    await fs.symlink(outsideShared, workspace.sharedDir);
    await expect(workflow.runTask(workspace, created, "sync-local")).rejects.toThrow(
      /Shared path must be a directory, not a link/u,
    );
    await expect(workspaces.find(workspace.root)).rejects.toThrow(
      /Shared path must be a directory, not a link/u,
    );
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
