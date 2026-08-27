import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "src", "cli.ts");
const tsxLoader = import.meta.resolve("tsx");

function cliArguments(...args: string[]): string[] {
  return ["--import", tsxLoader, cli, ...args];
}

async function runCli(cwd: string, ...args: string[]) {
  return await execa(process.execPath, cliArguments(...args), { cwd, reject: false });
}

describe("ygg status", { timeout: 30_000 }, () => {
  let temporaryRoot: string;
  let repository: TestRepository;
  let workspace: string;
  let main: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-status-test-"));
    repository = await createTestRepository(temporaryRoot);
    workspace = path.join(temporaryRoot, "workspace");
    main = path.join(workspace, "main");

    const initialized = await runCli(temporaryRoot, "init", repository.remote, workspace);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const created = await runCli(workspace, "create", "main", "--no-fetch");
    expect(created.exitCode, created.stderr).toBe(0);
    await runGit(["branch", "--set-upstream-to=origin/main", "main"], main);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("prints a five-line dashboard and stable JSON for the current worktree", async () => {
    const human = await runCli(main, "status");
    const json = await execa(process.execPath, cliArguments("status", "--json"), {
      cwd: main,
      env: { FORCE_COLOR: "1", NO_COLOR: undefined },
      reject: false,
    });

    expect(human.exitCode, human.stderr).toBe(0);
    const lines = stripVTControlCharacters(human.stdout).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain(`Workspace  ${await fs.realpath(workspace)} · default main`);
    expect(lines[1]).toContain("Current    main · main · linked · clean");
    expect(lines[2]).toContain("Tracking   origin/main · ahead 0 · behind 0 · local refs");
    expect(lines[3]).toBe("Project    none");
    expect(lines[4]).toContain("Worktrees  1 total · 1 clean · 0 modified · 0 locked · 0 missing");

    expect(json.exitCode, json.stderr).toBe(0);
    expect(json.stdout).not.toContain("\u001B[");
    expect(JSON.parse(json.stdout)).toEqual({
      workspace: { root: await fs.realpath(workspace), defaultBranch: "main" },
      current: expect.objectContaining({
        name: "main",
        path: await fs.realpath(main),
        branch: "main",
        role: "linked",
        state: "clean",
        head: expect.any(String),
        tracking: { state: "tracked", upstream: "origin/main", ahead: 0, behind: 0 },
      }),
      project: null,
      worktrees: {
        total: 1,
        clean: 1,
        modified: 0,
        locked: 0,
        missing: 0,
        unavailable: 0,
      },
    });
  });

  it("uses the default worktree configuration from the workspace root and reports trust", async () => {
    const configPath = path.join(main, ".ygg.yml");
    await fs.writeFile(configPath, "version: 1\ndefaults:\n  fetch: false\n", "utf8");
    const canonicalConfigPath = await fs.realpath(configPath);

    const declarative = await runCli(workspace, "status", "--json");
    expect(declarative.exitCode, declarative.stderr).toBe(0);
    expect(JSON.parse(declarative.stdout)).toMatchObject({
      current: null,
      project: {
        path: canonicalConfigPath,
        sources: { repository: canonicalConfigPath, workspace: null },
        trust: "not-required",
      },
    });

    await fs.writeFile(
      configPath,
      "version: 1\ntasks:\n  verify:\n    steps:\n      - type: command\n        argv: [node, --version]\n",
      "utf8",
    );
    const untrusted = await runCli(workspace, "status", "--json");
    expect(untrusted.exitCode, untrusted.stderr).toBe(0);
    expect(JSON.parse(untrusted.stdout).project.trust).toBe("untrusted");

    const trusted = await runCli(main, "config", "trust", "--yes");
    expect(trusted.exitCode, trusted.stderr).toBe(0);
    const status = await runCli(workspace, "status", "--json");
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).project.trust).toBe("trusted");

    const human = await runCli(workspace, "status");
    expect(stripVTControlCharacters(human.stdout)).toContain("Current    workspace root");
    expect(stripVTControlCharacters(human.stdout)).toContain("Tracking   not applicable");
  });

  it("compares only local tracking refs and preserves ahead/behind direction", async () => {
    await fs.writeFile(path.join(repository.source, "remote.txt"), "remote\n", "utf8");
    await runGit(["add", "remote.txt"], repository.source);
    await runGit(["commit", "-m", "remote change"], repository.source);
    await runGit(["push", "origin", "main"], repository.source);

    const beforeFetch = await runCli(main, "status", "--json");
    expect(JSON.parse(beforeFetch.stdout).current.tracking).toMatchObject({
      ahead: 0,
      behind: 0,
    });

    await runGit(["fetch", "origin"], main);
    const behind = await runCli(main, "status", "--json");
    expect(JSON.parse(behind.stdout).current.tracking).toMatchObject({ ahead: 0, behind: 1 });

    await runGit(["config", "user.email", "tests@example.invalid"], main);
    await runGit(["config", "user.name", "ygg tests"], main);
    await runGit(["commit", "--allow-empty", "-m", "local change"], main);
    const diverged = await runCli(main, "status", "--json");
    expect(JSON.parse(diverged.stdout).current.tracking).toMatchObject({ ahead: 1, behind: 1 });
  });

  it("distinguishes missing, gone, and not-applicable tracking", async () => {
    await runGit(["branch", "--unset-upstream", "main"], main);
    const none = await runCli(main, "status", "--json");
    expect(JSON.parse(none.stdout).current.tracking).toEqual({
      state: "none",
      upstream: null,
      ahead: null,
      behind: null,
    });

    await runGit(["branch", "--set-upstream-to=origin/main", "main"], main);
    await runGit(
      ["update-ref", "-d", "refs/remotes/origin/main"],
      path.join(workspace, "repo.git"),
      {
        gitDir: true,
      },
    );
    const gone = await runCli(main, "status", "--json");
    expect(JSON.parse(gone.stdout).current.tracking).toEqual({
      state: "gone",
      upstream: "origin/main",
      ahead: null,
      behind: null,
    });

    await runGit(["switch", "--detach"], main);
    const detached = await runCli(main, "status", "--json");
    expect(JSON.parse(detached.stdout).current).toMatchObject({
      branch: null,
      tracking: { state: "not-applicable", upstream: null, ahead: null, behind: null },
    });
  });

  it("aggregates modified, locked, and missing worktrees without failing", async () => {
    const feature = path.join(workspace, "feature");
    const deleted = path.join(workspace, "deleted");
    expect((await runCli(workspace, "create", "feature", "--no-fetch")).exitCode).toBe(0);
    expect((await runCli(workspace, "create", "deleted", "--no-fetch")).exitCode).toBe(0);
    await fs.writeFile(path.join(main, "dirty.txt"), "keep\n", "utf8");
    await runGit(["worktree", "lock", feature], path.join(workspace, "repo.git"), {
      gitDir: true,
    });
    await fs.rm(deleted, { recursive: true });

    const status = await runCli(workspace, "status", "--json");

    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).worktrees).toEqual({
      total: 3,
      clean: 0,
      modified: 1,
      locked: 1,
      missing: 1,
      unavailable: 0,
    });
  });
});

async function runGit(
  args: string[],
  cwd: string,
  options: { gitDir?: boolean } = {},
): Promise<void> {
  await execa("git", options.gitDir ? [`--git-dir=${cwd}`, ...args] : args, {
    cwd: options.gitDir ? undefined : cwd,
  });
}
