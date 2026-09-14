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

describe("automation JSON contracts", { timeout: 20_000 }, () => {
  let temporaryRoot: string;
  let repository: TestRepository;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wald-json-test-"));
    repository = await createTestRepository(temporaryRoot);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("emits one JSON document for every mutating lifecycle command", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const initialized = await runCli(temporaryRoot, "init", repository.remote, workspace, "--json");
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      action: "initialized",
      workspace: { root: await fs.realpath(workspace), mode: "managed", defaultBranch: "main" },
      restored: [],
    });

    const created = await runCli(workspace, "create", "main", "--no-fetch", "--json");
    expect(created.exitCode, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      action: "created",
      strategy: { type: "local" },
      worktree: { name: "main", branch: "main" },
    });

    const handedOff = await runCli(
      path.join(workspace, "main"),
      "handoff",
      "feature/handoff",
      "--no-fetch",
      "--json",
    );
    expect(handedOff.exitCode, handedOff.stderr).toBe(0);
    expect(JSON.parse(handedOff.stdout)).toMatchObject({
      action: "created",
      strategy: { type: "new" },
      worktree: { name: "feature-handoff", branch: "feature/handoff" },
      carry: { summary: { staged: 0, unstaged: 0, untracked: 0 } },
    });

    const renamed = await runCli(workspace, "rename", "feature-handoff", "review-ready", "--json");
    expect(renamed.exitCode, renamed.stderr).toBe(0);
    expect(JSON.parse(renamed.stdout)).toMatchObject({
      action: "renamed",
      before: { name: "feature-handoff", branch: "feature/handoff" },
      worktree: { name: "review-ready", branch: "review-ready" },
      branchChange: {
        before: "feature/handoff",
        after: "review-ready",
        renamed: true,
        upstream: null,
      },
    });

    const removed = await runCli(workspace, "remove", "review-ready", "--yes", "--json");
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      action: "removed",
      worktrees: [{ name: "review-ready", branch: "review-ready" }],
      deletedBranches: [],
      keptBranches: ["review-ready"],
    });
  });

  it("reports multiple removed worktrees and branch decisions", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    await runCli(temporaryRoot, "init", repository.remote, workspace, "--json");
    await runCli(workspace, "create", "main", "--no-fetch", "--json");
    await runCli(workspace, "create", "feature/one", "--no-fetch", "--json");
    await runCli(workspace, "create", "feature/two", "--no-fetch", "--json");

    const removed = await runCli(
      workspace,
      "remove",
      "feature-one",
      "feature-two",
      "--delete-branch",
      "--yes",
      "--json",
    );

    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      action: "removed",
      worktrees: [
        { name: "feature-one", branch: "feature/one" },
        { name: "feature-two", branch: "feature/two" },
      ],
      deletedBranches: ["feature/one", "feature/two"],
      keptBranches: [],
    });
  });

  it("exposes custom, kept, default and detached rename branches in terminal and JSON output", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    await runCli(temporaryRoot, "init", repository.remote, workspace, "--json");
    await runCli(workspace, "create", "feature/payment", "--no-fetch", "--json");
    await execa("git", ["branch", "--set-upstream-to=origin/main", "feature/payment"], {
      cwd: path.join(workspace, "feature-payment"),
    });
    const renamed = await runCli(
      workspace,
      "rename",
      "feature-payment",
      "review",
      "--branch",
      "feature/payment-review",
    );
    expect(renamed.exitCode, renamed.stderr).toBe(0);
    expect(renamed.stdout).toContain("Branch renamed: feature/payment → feature/payment-review");
    expect(renamed.stdout).toContain("Upstream kept: origin/main");

    const kept = await runCli(
      workspace,
      "rename",
      "review",
      "review-ready",
      "--keep-branch",
      "--json",
    );
    expect(kept.exitCode, kept.stderr).toBe(0);
    expect(JSON.parse(kept.stdout)).toMatchObject({
      before: { name: "review", branch: "feature/payment-review" },
      branchChange: {
        before: "feature/payment-review",
        after: "feature/payment-review",
        renamed: false,
        upstream: "origin/main",
      },
      worktree: { name: "review-ready", branch: "feature/payment-review" },
    });

    const keptText = await runCli(
      workspace,
      "rename",
      "review-ready",
      "review-final",
      "--keep-branch",
    );
    expect(keptText.exitCode, keptText.stderr).toBe(0);
    expect(keptText.stdout).toContain("Branch kept: feature/payment-review");
    await execa("git", ["checkout", "--detach"], { cwd: path.join(workspace, "review-final") });
    const detached = await runCli(
      workspace,
      "rename",
      "review-final",
      "detached-review",
      "--keep-branch",
      "--json",
    );
    expect(detached.exitCode, detached.stderr).toBe(0);
    expect(JSON.parse(detached.stdout)).toMatchObject({
      before: { branch: null },
      branchChange: { before: null, after: null, renamed: false, upstream: null },
      worktree: { name: "detached-review", branch: null },
    });

    await runCli(workspace, "create", "main", "--no-fetch", "--json");
    const keptDefault = await runCli(
      workspace,
      "rename",
      "main",
      "main-checkout",
      "--keep-branch",
      "--json",
    );
    expect(keptDefault.exitCode, keptDefault.stderr).toBe(0);
    expect(JSON.parse(keptDefault.stdout)).toMatchObject({
      branchChange: { before: "main", after: "main", renamed: false },
      worktree: { name: "main-checkout", branch: "main" },
    });
  });

  it("keeps JSON stdout empty and reports safe effects after a post-remove hook failure", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    await runCli(temporaryRoot, "init", repository.remote, workspace, "--json");
    await runCli(workspace, "create", "main", "--no-fetch", "--json");
    await runCli(workspace, "create", "feature/failing-remove", "--no-fetch", "--json");
    await fs.writeFile(
      path.join(workspace, ".wald", "project.yml"),
      `version: 1
hooks:
  post_remove:
    - type: command
      argv: [node, -e, "process.exit(7)"]
`,
      "utf8",
    );
    const trusted = await runCli(workspace, "config", "trust", "--yes");
    expect(trusted.exitCode, trusted.stderr).toBe(0);

    const removed = await runCli(workspace, "remove", "feature-failing-remove", "--yes", "--json");

    expect(removed.exitCode).toBe(1);
    expect(removed.stdout).toBe("");
    const error = JSON.parse(removed.stderr.trim().split("\n").at(-1) as string);
    expect(error).toMatchObject({
      exitCode: 1,
      effects: {
        removedWorktrees: [{ name: "feature-failing-remove", branch: "feature/failing-remove" }],
        deletedBranches: [],
        keptBranches: ["feature/failing-remove"],
      },
    });
    await expect(fs.stat(path.join(workspace, "feature-failing-remove"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never prompts in JSON mode and writes structured errors only to stderr", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    await runCli(temporaryRoot, "init", repository.remote, workspace, "--json");
    const cases = [
      [workspace, ["create", "--json"]],
      [workspace, ["create", "feature/conflict", "--cd", "--json"]],
      [workspace, ["handoff", "--json"]],
      [workspace, ["rename", "main", "--json"]],
      [workspace, ["remove", "main", "--json"]],
      [temporaryRoot, ["init", "--json"]],
    ] as const;

    for (const [cwd, args] of cases) {
      const result = await runCli(cwd, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        message: expect.any(String),
        exitCode: 1,
      });
    }
  });

  it("reports doctor warnings outside a workspace as JSON with exit code zero", async () => {
    const result = await runCli(temporaryRoot, "doctor", "--json");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "warning",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "workspace.discovery", status: "warning" }),
      ]),
    });
  });

  it("returns a doctor failure report on stdout with exit code one", async () => {
    const broken = path.join(temporaryRoot, "broken");
    await fs.mkdir(path.join(broken, ".wald"), { recursive: true });
    await fs.writeFile(path.join(broken, ".wald", "workspace.yml"), "version: [\n", "utf8");

    const result = await runCli(broken, "doctor", "--json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "fail",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "workspace.configuration", status: "fail" }),
      ]),
    });
  });

  it("distinguishes initialized and unchanged adoption results", async () => {
    const initialized = await runCli(
      temporaryRoot,
      "init",
      "--adopt",
      repository.source,
      "--yes",
      "--config",
      "--json",
    );
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({ action: "initialized", restored: [] });

    const unchanged = await runCli(
      repository.source,
      "init",
      "--adopt",
      repository.source,
      "--yes",
      "--json",
    );
    expect(unchanged.exitCode, unchanged.stderr).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ action: "unchanged", restored: [] });
    await expect(
      fs.readFile(
        path.join(JSON.parse(initialized.stdout).workspace.gitDir, "wald", "project.yml"),
        "utf8",
      ),
    ).resolves.toContain("version: 1");

    const workspace = JSON.parse(initialized.stdout).workspace as { gitDir: string };
    await fs.rm(path.join(workspace.gitDir, "wald", "shared"), { recursive: true });
    const repaired = await runCli(
      repository.source,
      "init",
      "--adopt",
      repository.source,
      "--yes",
      "--json",
    );
    expect(repaired.exitCode, repaired.stderr).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({
      action: "repaired",
      restored: [expect.stringContaining("shared directory")],
    });
  });
});

async function runCli(cwd: string, ...args: string[]) {
  return await execa(process.execPath, cliArguments(...args), { cwd, reject: false });
}
