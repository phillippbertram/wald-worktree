import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitClient } from "../src/infrastructure/git-client.js";
import { AutomationService } from "../src/services/automation-service.js";
import { ConfigService } from "../src/services/config-service.js";
import { WorkspaceService } from "../src/services/workspace-service.js";
import { WorktreeService } from "../src/services/worktree-service.js";
import { WorktreeTransferService } from "../src/services/worktree-transfer-service.js";
import { WorktreeWorkflowService } from "../src/services/worktree-workflow-service.js";
import {
  createRemoteBranch,
  createTestRepository,
  type TestRepository,
} from "./helpers/git-repository.js";

describe("carry worktree lifecycle", () => {
  let previousCwd: string;
  let temporaryRoot: string;
  let repository: TestRepository;
  let git: GitClient;
  let configs: ConfigService;
  let workspaces: WorkspaceService;
  let worktrees: WorktreeService;

  beforeEach(async () => {
    previousCwd = process.cwd();
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-carry-workflow-test-"));
    repository = await createTestRepository(temporaryRoot);
    git = new GitClient();
    configs = new ConfigService();
    workspaces = new WorkspaceService(git, configs);
    worktrees = new WorktreeService(git);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("runs the trusted source lifecycle and carries the exact local state from HEAD", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "workspace"),
    );
    const source = await worktrees.add(workspace, { branch: "main", fetch: false });
    process.chdir(source.path);
    await fs.writeFile(
      path.join(source.path, ".ygg.yml"),
      `version: 1
hooks:
  pre_create:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('pre-create.txt', 'captured')"]
      cwd: source
  post_create:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('post-create.txt', 'ran')"]
`,
      "utf8",
    );
    await fs.writeFile(path.join(source.path, "README.md"), "# staged\n", "utf8");
    await git.run(["add", "README.md"], { cwd: source.path });
    await fs.appendFile(path.join(source.path, "README.md"), "unstaged\n", "utf8");
    await fs.writeFile(path.join(source.path, "local.bin"), Buffer.from([0, 255, 4]));
    const sourceHead = (await git.run(["rev-parse", "HEAD"], { cwd: source.path })).stdout;

    const workflow = new WorktreeWorkflowService(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, {
      branch: "feature/carried",
      carry: true,
      fetch: false,
    });

    expect(plan.carrySource?.path).toBe(source.path);
    expect(plan.prepared.strategy).toEqual({ type: "new", base: sourceHead });
    expect(plan.trusted).toBe(false);
    await expect(workflow.executeCreate(plan)).rejects.toThrow(/not trusted/u);
    if (!plan.project) throw new Error("Expected uncommitted source configuration.");
    await configs.trust(workspace, plan.project);

    const created = await workflow.executeCreate(plan);

    expect(created.head).toBe(sourceHead);
    expect(created.carry).toMatchObject({
      sourcePath: source.path,
      summary: { staged: 1, unstaged: 1, untracked: 3 },
    });
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
      "# staged\nunstaged\n",
    );
    expect(await fs.readFile(path.join(created.path, "local.bin"))).toEqual(
      Buffer.from([0, 255, 4]),
    );
    expect(await fs.readFile(path.join(created.path, "pre-create.txt"), "utf8")).toBe("captured");
    expect(await fs.readFile(path.join(created.path, "post-create.txt"), "utf8")).toBe("ran");
    expect(await fs.readFile(path.join(source.path, "pre-create.txt"), "utf8")).toBe("captured");
    await expect(fs.stat(path.join(source.path, "post-create.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await git.run(["diff", "--cached", "--name-only"], { cwd: source.path })).stdout).toBe(
      "README.md",
    );
    expect((await git.run(["diff", "--cached", "--name-only"], { cwd: created.path })).stdout).toBe(
      "README.md",
    );
  });

  it("allows a clean source but rejects --from and existing local or remote branch names", async () => {
    await createRemoteBranch(repository, "feature/remote");
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "clean-workspace"),
    );
    const source = await worktrees.add(workspace, { branch: "main", fetch: false });
    process.chdir(source.path);
    const workflow = new WorktreeWorkflowService(git, worktrees, configs);

    await expect(
      workflow.planCreate(workspace, {
        branch: "feature/from",
        from: "main",
        carry: true,
        fetch: false,
      }),
    ).rejects.toThrow(/Cannot combine carry with an explicit base/u);
    await expect(
      workflow.planCreate(workspace, { branch: "main", carry: true, fetch: false }),
    ).rejects.toThrow(/already checked out|must be a new branch/u);
    await expect(
      workflow.planCreate(workspace, { branch: "feature/remote", carry: true, fetch: false }),
    ).rejects.toThrow(/must be a new branch/u);

    const plan = await workflow.planCreate(workspace, {
      branch: "feature/clean",
      carry: true,
      fetch: false,
    });
    const created = await workflow.executeCreate(plan);
    expect(created.carry?.summary).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
    expect(created.state).toBe("clean");
  });

  it("rolls back its fresh worktree and branch when transfer fails before post-create", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "rollback-workspace"),
    );
    const source = await worktrees.add(workspace, { branch: "main", fetch: false });
    process.chdir(source.path);
    await fs.writeFile(path.join(source.path, "local.txt"), "keep source\n", "utf8");
    const transfers = new WorktreeTransferService(git);
    vi.spyOn(transfers, "apply").mockRejectedValueOnce(new Error("injected apply failure"));
    const workflow = new WorktreeWorkflowService(git, worktrees, configs, undefined, transfers);
    const plan = await workflow.planCreate(workspace, {
      branch: "feature/rollback",
      carry: true,
      fetch: false,
    });

    await expect(workflow.executeCreate(plan)).rejects.toThrow(
      /created worktree and branch were rolled back[\s\S]*injected apply failure/u,
    );
    expect((await worktrees.list(workspace)).map((worktree) => worktree.path)).toEqual([
      source.path,
    ]);
    expect(
      await git.succeeds(["show-ref", "--verify", "--quiet", "refs/heads/feature/rollback"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(false);
    expect(await fs.readFile(path.join(source.path, "local.txt"), "utf8")).toBe("keep source\n");
  });

  it("rechecks uncommitted source configuration after pre-create before creating anything", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "config-drift-workspace"),
    );
    const source = await worktrees.add(workspace, { branch: "main", fetch: false });
    process.chdir(source.path);
    const configPath = path.join(source.path, ".ygg.yml");
    await fs.writeFile(
      configPath,
      `version: 1
hooks:
  pre_create:
    - type: command
      argv: [node, --version]
`,
      "utf8",
    );
    const automation = new AutomationService();
    vi.spyOn(automation, "runHook").mockImplementation(async (_project, event) => {
      if (event === "pre_create") await fs.writeFile(configPath, "version: 1\n", "utf8");
    });
    const workflow = new WorktreeWorkflowService(git, worktrees, configs, automation);
    const plan = await workflow.planCreate(workspace, {
      branch: "feature/config-drift",
      carry: true,
      fetch: false,
    });
    if (!plan.project) throw new Error("Expected source configuration.");
    await configs.trust(workspace, plan.project);

    await expect(workflow.executeCreate(plan)).rejects.toThrow(
      /effective project configuration changed after pre-create/u,
    );
    expect((await worktrees.list(workspace)).map((worktree) => worktree.path)).toEqual([
      source.path,
    ]);
    expect(
      await git.succeeds(["show-ref", "--verify", "--quiet", "refs/heads/feature/config-drift"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(false);
  });

  it("keeps a fully carried worktree when post-create fails", async () => {
    await fs.writeFile(
      path.join(repository.source, ".ygg.yml"),
      `version: 1
hooks:
  post_create:
    - type: command
      argv: [node, -e, "process.exit(19)"]
`,
      "utf8",
    );
    await git.run(["add", ".ygg.yml"], { cwd: repository.source });
    await git.run(["commit", "-m", "add failing hook"], { cwd: repository.source });
    await git.run(["push", "origin", "main"], { cwd: repository.source });
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "post-failure-workspace"),
    );
    const source = await worktrees.add(workspace, { branch: "main", fetch: false });
    process.chdir(source.path);
    await fs.writeFile(path.join(source.path, "local.txt"), "carried\n", "utf8");
    const workflow = new WorktreeWorkflowService(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, {
      branch: "feature/post-failure",
      carry: true,
      fetch: false,
    });
    if (!plan.project) throw new Error("Expected project configuration.");
    await configs.trust(workspace, plan.project);

    await expect(workflow.executeCreate(plan)).rejects.toThrow(
      /post-create setup failed[\s\S]*ygg setup/u,
    );
    const created = await worktrees.resolve(workspace, "feature/post-failure");
    expect(await fs.readFile(path.join(created.path, "local.txt"), "utf8")).toBe("carried\n");
    expect(await fs.readFile(path.join(source.path, "local.txt"), "utf8")).toBe("carried\n");
  });

  it("preserves the recovery target when automatic rollback cannot complete", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "rollback-failure-workspace"),
    );
    const source = await worktrees.add(workspace, { branch: "main", fetch: false });
    process.chdir(source.path);
    await fs.writeFile(path.join(source.path, "local.txt"), "keep source\n", "utf8");
    const transfers = new WorktreeTransferService(git);
    vi.spyOn(transfers, "apply").mockRejectedValueOnce(new Error("injected apply failure"));
    vi.spyOn(worktrees, "rollbackCreated").mockRejectedValueOnce(
      new Error("injected rollback failure"),
    );
    const workflow = new WorktreeWorkflowService(git, worktrees, configs, undefined, transfers);
    const plan = await workflow.planCreate(workspace, {
      branch: "feature/recovery",
      carry: true,
      fetch: false,
    });

    await expect(workflow.executeCreate(plan)).rejects.toThrow(
      /Automatic rollback did not complete[\s\S]*feature\/recovery/u,
    );
    const recovery = await worktrees.resolve(workspace, "feature/recovery");
    await expect(fs.stat(recovery.path)).resolves.toSatisfy((stat) => stat.isDirectory());
    expect(
      await git.succeeds(["show-ref", "--verify", "--quiet", "refs/heads/feature/recovery"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(true);
    expect(await fs.readFile(path.join(source.path, "local.txt"), "utf8")).toBe("keep source\n");
  });
});
