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

  it("initializes, adds, lists, and safely removes through the non-TTY command interface", async () => {
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

    const added = await execa(
      process.execPath,
      cliArguments("add", "main", "--no-fetch", "--no-env"),
      {
        cwd: workspace,
        reject: false,
      },
    );
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout).toContain("Created main");

    const listed = await execa(process.execPath, cliArguments("list", "--json"), {
      cwd: workspace,
      reject: false,
    });
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ branch: "main", name: "main", state: "clean" }),
    ]);

    const refused = await execa(process.execPath, cliArguments("remove", "main"), {
      cwd: workspace,
      reject: false,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("requires --force");

    const removed = await execa(process.execPath, cliArguments("remove", "main", "--force"), {
      cwd: workspace,
      reject: false,
    });
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.stdout).toContain("Removed main");
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
    expect(adopted.stdout).toContain("Adopted repository");
    expect(await fs.readFile(configPath, "utf8")).toBe(configBefore);

    const listed = await execa(process.execPath, cliArguments("list", "--json"), {
      cwd: repository.source,
      reject: false,
    });
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ branch: "main", name: "source", role: "primary" }),
    ]);

    const refused = await execa(process.execPath, cliArguments("remove", "source", "--force"), {
      cwd: repository.source,
      reject: false,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("primary checkout cannot be removed");

    const repeated = await execa(
      process.execPath,
      cliArguments("init", "--adopt", repository.source, "--yes"),
      { cwd: temporaryRoot, reject: false },
    );
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.stdout).toContain("already initialized");
  });
});
