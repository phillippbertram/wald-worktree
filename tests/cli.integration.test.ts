import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "src", "cli.ts");
const tsxLoader = import.meta.resolve("tsx");

function cliArguments(...args: string[]): string[] {
  return ["--import", tsxLoader, cli, ...args];
}

describe("CLI smoke flow", () => {
  let temporaryRoot: string;
  let repository: TestRepository;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wt-cli-test-"));
    repository = await createTestRepository(temporaryRoot);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("initializes, creates, lists, and safely removes through the non-TTY command interface", async () => {
    const workspace = path.join(temporaryRoot, "workspace");

    const initialized = await execa(
      process.execPath,
      cliArguments("init", repository.remote, workspace),
      {
        cwd: temporaryRoot,
        reject: false,
      },
    );
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(initialized.stdout).toContain("Initialized workspace");
    expect(initialized.stdout).toContain(`Next: cd '${await fs.realpath(workspace)}'`);
    expect(initialized.stdout).toContain("Then: wt create 'main' --cd");

    const added = await execa(process.execPath, cliArguments("create", "main", "--no-fetch"), {
      cwd: workspace,
      reject: false,
    });
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout).toContain("Created main");
    expect(added.stdout).toContain("Without shell integration: cd");

    const directCd = await execa(
      process.execPath,
      cliArguments("create", "feature/direct-cd", "--no-fetch", "--cd"),
      { cwd: workspace, reject: false },
    );
    expect(directCd.exitCode, directCd.stderr).toBe(0);
    expect(directCd.stdout).toContain("Shell integration is not active");
    expect(directCd.stdout).toContain("Enter with: cd");

    const listed = await execa(process.execPath, cliArguments("list", "--json"), {
      cwd: workspace,
      reject: false,
    });
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: "main", name: "main", state: "clean" }),
        expect.objectContaining({ branch: "feature/direct-cd", name: "feature-direct-cd" }),
      ]),
    );

    const configured = await execa(
      process.execPath,
      cliArguments("config", "init", "main", "--yes"),
      { cwd: workspace, reject: false },
    );
    expect(configured.exitCode, configured.stderr).toBe(0);
    expect(configured.stdout).toContain("Created");
    expect(configured.stdout).toContain("review and commit .wt.yml");
    await expect(fs.readFile(path.join(workspace, "main", ".wt.yml"), "utf8")).resolves.toContain(
      "version: 1",
    );
    const refusedOverwrite = await execa(
      process.execPath,
      cliArguments("config", "init", "main", "--yes"),
      { cwd: workspace, reject: false },
    );
    expect(refusedOverwrite.exitCode).toBe(1);
    expect(refusedOverwrite.stderr).toContain("Use --force to replace it");

    await fs.writeFile(path.join(workspace, "main", "untracked.txt"), "keep me\n", "utf8");

    const refused = await execa(process.execPath, cliArguments("remove", "main", "--yes"), {
      cwd: workspace,
      reject: false,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("use --force only if this data can be discarded");

    const removed = await execa(
      process.execPath,
      cliArguments("remove", "main", "--force", "--yes"),
      {
        cwd: workspace,
        reject: false,
      },
    );
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.stdout).toContain("Removed main");
  });

  it("previews and explicitly prunes only stale worktree metadata", async () => {
    const workspace = path.join(temporaryRoot, "prune-workspace");
    await execa(process.execPath, cliArguments("init", repository.remote, workspace), {
      cwd: temporaryRoot,
    });
    await execa(process.execPath, cliArguments("create", "main", "--no-fetch"), {
      cwd: workspace,
    });
    await execa(process.execPath, cliArguments("create", "feature/stale", "--no-fetch"), {
      cwd: workspace,
    });
    const stalePath = path.join(workspace, "feature-stale");
    await fs.rm(stalePath, { recursive: true });

    const preview = await execa(process.execPath, cliArguments("prune"), {
      cwd: workspace,
      reject: false,
    });
    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("Stale worktree metadata:");
    expect(preview.stdout).toContain("feature-stale");
    expect(preview.stdout).toContain("Preview only");
    const metadataBefore = await execa(
      "git",
      [`--git-dir=${path.join(workspace, "repo.git")}`, "worktree", "list", "--porcelain"],
      { cwd: workspace },
    );
    expect(metadataBefore.stdout).toContain(stalePath);

    const confirmationRequired = await execa(process.execPath, cliArguments("prune", "--apply"), {
      cwd: workspace,
      reject: false,
    });
    expect(confirmationRequired.exitCode).toBe(1);
    expect(confirmationRequired.stderr).toContain("requires --apply --yes");

    const applied = await execa(process.execPath, cliArguments("prune", "--apply", "--yes"), {
      cwd: workspace,
      reject: false,
    });
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(applied.stdout).toContain("Pruned 1 stale worktree registration");
    const metadataAfter = await execa(
      "git",
      [`--git-dir=${path.join(workspace, "repo.git")}`, "worktree", "list", "--porcelain"],
      { cwd: workspace },
    );
    expect(metadataAfter.stdout).not.toContain(stalePath);
    await expect(fs.stat(path.join(workspace, "main"))).resolves.toSatisfy((stat) =>
      stat.isDirectory(),
    );
    const branch = await execa(
      "git",
      [
        `--git-dir=${path.join(workspace, "repo.git")}`,
        "show-ref",
        "--verify",
        "refs/heads/feature/stale",
      ],
      { cwd: workspace, reject: false },
    );
    expect(branch.exitCode).toBe(0);

    const repeated = await execa(process.execPath, cliArguments("prune"), {
      cwd: workspace,
      reject: false,
    });
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.stdout).toContain("No stale worktree metadata found");
  });

  it("adopts an existing checkout through explicit non-TTY options", async () => {
    const worktreeDir = path.join(temporaryRoot, "adopted-worktrees");
    const configPath = path.join(repository.source, ".git", "config");
    const configBefore = await fs.readFile(configPath, "utf8");

    const implicit = await execa(process.execPath, cliArguments("init"), {
      cwd: repository.source,
      reject: false,
    });
    expect(implicit.exitCode).toBe(1);
    expect(implicit.stderr).toContain("requires --adopt and --yes");

    const adopted = await execa(
      process.execPath,
      cliArguments(
        "init",
        "--adopt",
        repository.source,
        "--yes",
        "--worktrees-dir",
        worktreeDir,
        "--remote",
        "origin",
        "--default-branch",
        "main",
      ),
      { cwd: temporaryRoot, reject: false },
    );
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain("Connected existing checkout");
    await expect(fs.stat(path.join(repository.source, ".wt.yml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(configPath, "utf8")).toBe(configBefore);

    const listed = await execa(process.execPath, cliArguments("list", "--json"), {
      cwd: repository.source,
      reject: false,
    });
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ branch: "main", name: "source", role: "primary" }),
    ]);

    const refused = await execa(
      process.execPath,
      cliArguments("remove", "source", "--force", "--yes"),
      {
        cwd: repository.source,
        reject: false,
      },
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("primary checkout cannot be removed");

    const sharedDir = path.join(repository.source, ".git", "wt", "shared");
    await fs.rm(sharedDir, { recursive: true });
    const repeated = await execa(
      process.execPath,
      cliArguments("init", "--adopt", repository.source, "--yes", "--config"),
      { cwd: temporaryRoot, reject: false },
    );
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.stdout).toContain("already initialized");
    expect(repeated.stdout).toContain("review and commit .wt.yml");
    await expect(fs.stat(sharedDir)).resolves.toSatisfy((stat) => stat.isDirectory());
    await expect(fs.readFile(path.join(repository.source, ".wt.yml"), "utf8")).resolves.toContain(
      "version: 1",
    );
  });

  it("initializes a grouped standalone layout and reports its absolute paths", async () => {
    const workspace = path.join(temporaryRoot, "grouped-cli-workspace");
    const initialized = await execa(
      process.execPath,
      cliArguments("init", repository.remote, workspace, "--worktrees-dir", "worktrees"),
      { cwd: temporaryRoot, reject: false },
    );
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    await expect(
      fs.readFile(path.join(workspace, ".wt", "workspace.yml"), "utf8"),
    ).resolves.toContain("worktrees: ../worktrees");
    expect((await fs.stat(path.join(workspace, ".wt", "shared"))).mode & 0o777).toBe(0o700);

    const created = await execa(process.execPath, cliArguments("create", "main", "--no-fetch"), {
      cwd: workspace,
      reject: false,
    });
    expect(created.exitCode, created.stderr).toBe(0);
    await expect(fs.stat(path.join(workspace, "worktrees", "main"))).resolves.toSatisfy((stat) =>
      stat.isDirectory(),
    );

    const configured = await execa(process.execPath, cliArguments("config"), {
      cwd: path.join(workspace, "worktrees", "main"),
      reject: false,
    });
    expect(configured.exitCode, configured.stderr).toBe(0);
    expect(configured.stdout).toContain(`workspace_root: ${await fs.realpath(workspace)}`);
    expect(configured.stdout).toContain(
      `worktrees_path: ${await fs.realpath(path.join(workspace, "worktrees"))}`,
    );
    expect(configured.stdout).toContain(
      `shared_path: ${await fs.realpath(path.join(workspace, ".wt", "shared"))}`,
    );
  });

  it("uses the current worktree HEAD as an explicit base", async () => {
    const workspace = path.join(temporaryRoot, "head-workspace");
    await execa(process.execPath, cliArguments("init", repository.remote, workspace), {
      cwd: temporaryRoot,
    });
    await execa(process.execPath, cliArguments("create", "main", "--no-fetch"), {
      cwd: workspace,
    });
    await execa(
      process.execPath,
      cliArguments("create", "feature/base", "--from", "main", "--no-fetch"),
      { cwd: workspace },
    );
    const basePath = path.join(workspace, "feature-base");
    await fs.writeFile(path.join(basePath, "stacked.txt"), "base\n", "utf8");
    await execa("git", ["add", "stacked.txt"], { cwd: basePath });
    await execa("git", ["commit", "-m", "add stacked base"], { cwd: basePath });
    const baseHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: basePath })).stdout;

    const stacked = await execa(
      process.execPath,
      cliArguments("create", "feature/stacked", "--from", "HEAD", "--no-fetch"),
      { cwd: basePath, reject: false },
    );
    expect(stacked.exitCode, stacked.stderr).toBe(0);
    expect(
      (await execa("git", ["rev-parse", "HEAD"], { cwd: path.join(workspace, "feature-stacked") }))
        .stdout,
    ).toBe(baseHead);
  });

  it("trusts project automation before the first checkout and exposes task and exec commands", async () => {
    await fs.writeFile(
      path.join(repository.source, ".wt.yml"),
      `version: 1
defaults:
  fetch: false
hooks:
  post_create:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('hook.log', process.env.WT_EVENT)"]
tasks:
  verify:
    steps:
      - type: command
        argv: [node, -e, "require('node:fs').writeFileSync('task.log', process.env.WT_EVENT)"]
  interrupt:
    steps:
      - type: command
        argv: [node, -e, "process.kill(process.pid, 'SIGINT')"]
tools:
  fixture-agent:
    description: Fixture foreground tool
    command: [node, -e, "require('node:fs').writeFileSync('tool.log', process.cwd())"]
    mode: foreground
`,
      "utf8",
    );
    await execa("git", ["add", ".wt.yml"], { cwd: repository.source });
    await execa("git", ["commit", "-m", "add wt automation"], { cwd: repository.source });
    await execa("git", ["push", "origin", "main"], { cwd: repository.source });

    const workspace = path.join(temporaryRoot, "configured-workspace");
    const initialized = await execa(
      process.execPath,
      cliArguments("init", repository.remote, workspace),
      { cwd: temporaryRoot, reject: false },
    );
    expect(initialized.exitCode, initialized.stderr).toBe(0);

    const validated = await execa(process.execPath, cliArguments("config"), {
      cwd: workspace,
      reject: false,
    });
    expect(validated.exitCode, validated.stderr).toBe(0);
    expect(validated.stdout).toContain("origin/main:.wt.yml");

    const untrusted = await execa(process.execPath, cliArguments("create", "main", "--no-fetch"), {
      cwd: workspace,
      reject: false,
    });
    expect(untrusted.exitCode).toBe(1);
    expect(untrusted.stderr).toContain("not trusted");
    await expect(fs.stat(path.join(workspace, "main"))).rejects.toMatchObject({ code: "ENOENT" });

    const trusted = await execa(process.execPath, cliArguments("config", "trust", "--yes"), {
      cwd: workspace,
      reject: false,
    });
    expect(trusted.exitCode, trusted.stderr).toBe(0);

    const created = await execa(
      process.execPath,
      cliArguments("create", "main", "--no-fetch", "--tool", "fixture-agent"),
      { cwd: workspace, reject: false },
    );
    expect(created.exitCode, created.stderr).toBe(0);
    expect(await fs.readFile(path.join(workspace, "main", "hook.log"), "utf8")).toBe("post_create");
    expect(await fs.readFile(path.join(workspace, "main", "tool.log"), "utf8")).toBe(
      await fs.realpath(path.join(workspace, "main")),
    );

    await fs.rm(path.join(workspace, "main", "hook.log"));
    const setup = await execa(process.execPath, cliArguments("setup", "main"), {
      cwd: workspace,
      reject: false,
    });
    expect(setup.exitCode, setup.stderr).toBe(0);
    expect(await fs.readFile(path.join(workspace, "main", "hook.log"), "utf8")).toBe("post_create");

    const task = await execa(process.execPath, cliArguments("run", "verify", "main"), {
      cwd: workspace,
      reject: false,
    });
    expect(task.exitCode, task.stderr).toBe(0);
    expect(await fs.readFile(path.join(workspace, "main", "task.log"), "utf8")).toBe("task:verify");

    const interrupted = await execa(process.execPath, cliArguments("run", "interrupt", "main"), {
      cwd: workspace,
      reject: false,
    });
    expect(interrupted.exitCode).toBe(130);
    expect(interrupted.stderr).not.toContain("Error:");
    expect(interrupted.stdout).not.toContain("Completed task interrupt");

    const executed = await execa(
      process.execPath,
      cliArguments(
        "exec",
        "main",
        "--",
        "node",
        "-e",
        "require('node:fs').writeFileSync('exec.log', process.cwd())",
      ),
      { cwd: workspace, reject: false },
    );
    expect(executed.exitCode, executed.stderr).toBe(0);
    expect(await fs.readFile(path.join(workspace, "main", "exec.log"), "utf8")).toBe(
      await fs.realpath(path.join(workspace, "main")),
    );

    await fs.rm(path.join(workspace, "main", "tool.log"));
    const opened = await execa(
      process.execPath,
      cliArguments("open", "main", "--tool", "fixture-agent"),
      { cwd: workspace, reject: false },
    );
    expect(opened.exitCode, opened.stderr).toBe(0);
    expect(await fs.readFile(path.join(workspace, "main", "tool.log"), "utf8")).toBe(
      await fs.realpath(path.join(workspace, "main")),
    );
  });
});
