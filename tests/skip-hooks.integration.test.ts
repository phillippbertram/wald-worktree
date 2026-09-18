import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/domain/types.js";
import { GitClient } from "../src/infrastructure/git-client.js";
import { ConfigService } from "../src/services/config-service.js";
import { WorkspaceService } from "../src/services/workspace-service.js";
import { WorktreeService } from "../src/services/worktree-service.js";
import { WorktreeWorkflowService } from "../src/services/worktree-workflow-service.js";
import { createTestRepository } from "./helpers/git-repository.js";

const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
const tsxLoader = import.meta.resolve("tsx");

describe("skipping create hooks", () => {
  let temporaryRoot: string;
  let git: GitClient;
  let configs: ConfigService;
  let worktrees: WorktreeService;
  let workflow: WorktreeWorkflowService;
  let workspace: Workspace;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wald-skip-hooks-test-"));
    const repository = await createTestRepository(temporaryRoot);
    git = new GitClient();
    configs = new ConfigService();
    worktrees = new WorktreeService(git);
    workflow = new WorktreeWorkflowService(git, worktrees, configs);
    await fs.writeFile(
      path.join(repository.source, ".wald.yml"),
      `version: 1
defaults:
  fetch: false
hooks:
  pre_create:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('pre-create.log', 'ran')"]
      cwd: workspace
  post_create:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('post-create.log', 'ran')"]
    - type: copy
      source: shared
      from: fixture.txt
      to: copied.txt
    - type: symlink
      source: shared
      from: fixture.txt
      to: linked.txt
tools:
  fixture-agent:
    command: [node, -e, "require('node:fs').writeFileSync('tool.log', 'ran')"]
    mode: foreground
`,
    );
    await git.run(["add", ".wald.yml"], { cwd: repository.source });
    await git.run(["commit", "-m", "add create automation"], { cwd: repository.source });
    await git.run(["push", "origin", "main"], { cwd: repository.source });
    workspace = await new WorkspaceService(git, configs).initialize(
      repository.remote,
      path.join(temporaryRoot, "workspace"),
    );
    await fs.writeFile(path.join(workspace.sharedDir, "fixture.txt"), "shared fixture\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it.each([false, true])(
    "skips all steps and preserves existing trust (trusted: %s)",
    async (trusted) => {
      const plan = await workflow.planCreate(workspace, { branch: "main", skipHooks: true });
      expect(plan.skipHooks).toBe(true);
      expect(plan.trusted).toBe(false);
      if (!plan.project) throw new Error("Expected project configuration.");
      if (trusted) await configs.trust(workspace, plan.project);
      const before = await fs.readFile(workspace.configPath, "utf8");

      const created = await workflow.executeCreate(plan, { trustProjectConfig: true });

      expect(created.branch).toBe("main");
      await expectNoHooks(workspace.root, created.path);
      expect(await fs.readFile(workspace.configPath, "utf8")).toBe(before);
      expect(configs.isTrusted(workspace, plan.project)).toBe(trusted);
      expect(await fs.readFile(path.join(workspace.sharedDir, "fixture.txt"), "utf8")).toBe(
        "shared fixture\n",
      );
    },
  );

  it("keeps hooks enabled by default and requires trust before creating the worktree", async () => {
    const plan = await workflow.planCreate(workspace, { branch: "main" });
    expect(plan.skipHooks).toBe(false);
    await expect(workflow.executeCreate(plan)).rejects.toThrow(/not trusted/u);
    expect(await worktrees.list(workspace)).toEqual([]);
    await expectNoHooks(workspace.root, plan.prepared.target);

    await workflow.executeCreate(plan, { trustProjectConfig: true });
    expect(await fs.readFile(path.join(workspace.root, "pre-create.log"), "utf8")).toBe("ran");
    expect(await fs.readFile(path.join(plan.prepared.target, "post-create.log"), "utf8")).toBe(
      "ran",
    );
    expect(await fs.readFile(path.join(plan.prepared.target, "copied.txt"), "utf8")).toBe(
      "shared fixture\n",
    );
    expect(await fs.realpath(path.join(plan.prepared.target, "linked.txt"))).toBe(
      path.join(workspace.sharedDir, "fixture.txt"),
    );
  });

  it.each([
    { command: "create", output: "plain" },
    { command: "plant", output: "json" },
    { command: "create", output: "print-path" },
  ])("supports $command with $output output without trust", async ({ command, output }) => {
    const before = await fs.readFile(workspace.configPath, "utf8");
    const result = await runCli(
      workspace.root,
      command,
      "main",
      "--skip-hooks",
      ...(output === "plain" ? [] : [`--${output}`]),
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const created = await worktrees.resolve(workspace, "main");
    if (output === "json") {
      const { name, branch, path: worktreePath, role, state, head } = created;
      expect(JSON.parse(result.stdout)).toEqual({
        action: "created",
        strategy: { type: "local" },
        worktree: { name, branch, path: worktreePath, role, state, head },
      });
    } else if (output === "print-path") {
      expect(result.stdout).toBe(created.path);
    } else {
      expect(result.stdout).toContain("Created main");
    }
    await expectNoHooks(workspace.root, created.path);
    expect(await fs.readFile(workspace.configPath, "utf8")).toBe(before);
  });

  it.each(["create", "handoff"])(
    "carries local state with %s while hooks are skipped",
    async (command) => {
      const source = await worktrees.add(workspace, { branch: "main", fetch: false });
      await fs.writeFile(path.join(source.path, "README.md"), "staged\n");
      await git.run(["add", "README.md"], { cwd: source.path });
      await fs.appendFile(path.join(source.path, "README.md"), "unstaged\n");
      await fs.writeFile(path.join(source.path, "local.txt"), "untracked\n");
      const sourceBefore = await codeState(git, source.path);
      const configBefore = await fs.readFile(workspace.configPath, "utf8");

      const result = await runCli(
        source.path,
        command,
        "feature/carried",
        ...(command === "create" ? ["--carry"] : []),
        "--skip-hooks",
        "--json",
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const target = await worktrees.resolve(workspace, "feature-carried");
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "created",
        worktree: { branch: "feature/carried" },
        carry: { sourcePath: source.path, summary: { staged: 1, unstaged: 1, untracked: 1 } },
      });
      expect(await codeState(git, target.path)).toEqual(sourceBefore);
      expect(await codeState(git, source.path)).toEqual(sourceBefore);
      await expectNoHooks(workspace.root, target.path);
      await expectNoHooks(workspace.root, source.path);
      expect(await fs.readFile(workspace.configPath, "utf8")).toBe(configBefore);
    },
  );

  it.each(["--tool", "--open"])("still checks trust before opening via %s", async (option) => {
    await fs.writeFile(
      path.join(workspace.root, ".wald", "project.yml"),
      "version: 1\ndefaults:\n  tool: fixture-agent\n",
    );
    const before = await fs.readFile(workspace.configPath, "utf8");
    const result = await runCli(
      workspace.root,
      "create",
      "main",
      "--skip-hooks",
      ...(option === "--tool" ? ["--tool", "fixture-agent"] : ["--open"]),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("opening it failed");
    expect(result.stderr).toContain("not trusted");
    const created = await worktrees.resolve(workspace, "main");
    await expectNoHooks(workspace.root, created.path);
    await expect(fs.lstat(path.join(created.path, "tool.log"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(workspace.configPath, "utf8")).toBe(before);
  });

  it("allows post-create setup later without persisting the skip decision", async () => {
    const created = await workflow.executeCreate(
      await workflow.planCreate(workspace, { branch: "main", skipHooks: true }),
    );
    await expectNoHooks(workspace.root, created.path);
    const rejected = await runCli(workspace.root, "setup", "main");
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("not trusted");
    const trusted = await runCli(workspace.root, "config", "trust", "--yes");
    expect(trusted.exitCode, trusted.stderr).toBe(0);

    const setup = await runCli(workspace.root, "setup", "main");

    expect(setup.exitCode, setup.stderr).toBe(0);
    expect(await fs.readFile(path.join(created.path, "post-create.log"), "utf8")).toBe("ran");
    expect(await fs.readFile(path.join(created.path, "copied.txt"), "utf8")).toBe(
      "shared fixture\n",
    );
    expect(
      await fs.lstat(path.join(created.path, "linked.txt")).then((stat) => stat.isSymbolicLink()),
    ).toBe(true);
    await expect(fs.lstat(path.join(workspace.root, "pre-create.log"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("opens an explicitly requested trusted tool without running create hooks", async () => {
    const plan = await workflow.planCreate(workspace, { branch: "main" });
    if (!plan.project) throw new Error("Expected project configuration.");
    await configs.trust(workspace, plan.project);
    const before = await fs.readFile(workspace.configPath, "utf8");

    const result = await runCli(
      workspace.root,
      "create",
      "main",
      "--skip-hooks",
      "--tool",
      "fixture-agent",
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const created = await worktrees.resolve(workspace, "main");
    expect(await fs.readFile(path.join(created.path, "tool.log"), "utf8")).toBe("ran");
    await expectNoHooks(workspace.root, created.path);
    expect(await fs.readFile(workspace.configPath, "utf8")).toBe(before);
  });

  it("still validates configuration before creation", async () => {
    await fs.writeFile(path.join(workspace.root, ".wald", "project.yml"), "version: invalid\n");
    const result = await runCli(workspace.root, "create", "main", "--skip-hooks");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid");
    expect(await worktrees.list(workspace)).toEqual([]);
  });

  it("preserves the created checkout when its configuration differs from the plan", async () => {
    const plan = await workflow.planCreate(workspace, { branch: "main", skipHooks: true });
    const createPrepared = worktrees.createPrepared.bind(worktrees);
    vi.spyOn(worktrees, "createPrepared").mockImplementationOnce(async (...args) => {
      const created = await createPrepared(...args);
      await fs.writeFile(path.join(created.path, ".wald.yml"), "version: 1\n");
      return created;
    });

    await expect(workflow.executeCreate(plan)).rejects.toThrow(
      /does not match the configuration inspected/u,
    );

    const created = await worktrees.resolve(workspace, "main");
    expect(await fs.readFile(path.join(created.path, ".wald.yml"), "utf8")).toBe("version: 1\n");
    await expectNoHooks(workspace.root, created.path);
    expect(workspace.config.trustedProjectConfig).toBeNull();
  });
});

async function runCli(cwd: string, ...args: string[]) {
  return await execa(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    reject: false,
  });
}

async function expectNoHooks(workspaceRoot: string, target: string): Promise<void> {
  for (const file of [
    path.join(workspaceRoot, "pre-create.log"),
    ...["post-create.log", "copied.txt", "linked.txt"].map((name) => path.join(target, name)),
  ]) {
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

async function codeState(git: GitClient, cwd: string) {
  return {
    head: (await git.run(["rev-parse", "HEAD"], { cwd })).stdout,
    status: (await git.run(["status", "--porcelain=v1", "-z"], { cwd })).stdout,
    staged: (await git.run(["diff", "--cached", "--binary"], { cwd })).stdout,
    unstaged: (await git.run(["diff", "--binary"], { cwd })).stdout,
    untracked: await fs.readFile(path.join(cwd, "local.txt"), "utf8"),
  };
}
