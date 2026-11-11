import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliArguments, cliExecutable } from "./helpers/cli.js";
import { createTestRepository } from "./helpers/git-repository.js";

describe("global working directory", { timeout: 30_000 }, () => {
  let root: string;
  let workspace: string;
  let main: string;

  const run = (...args: string[]) =>
    execa(cliExecutable, cliArguments(...args), { cwd: root, reject: false });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wald-directory-")));
    const repository = await createTestRepository(root);
    workspace = path.join(root, "workspace with spaces");
    main = path.join(workspace, "main");
    const initialized = await run("init", repository.remote, workspace);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const created = await run("-C", workspace, "create", "main", "--no-fetch");
    expect(created.exitCode, created.stderr).toBe(0);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("selects a worktree with relative, absolute, repeated, compact, and long options", async () => {
    await fs.mkdir(path.join(main, "nested"));
    await fs.symlink(main, path.join(root, "alias"));
    for (const args of [
      ["-C", main, "status", "--json"],
      ["-C", "workspace with spaces", "-C", "main/nested", "status", "--json"],
      [`-C${main}`, "status", "--json"],
      [`--directory=${main}`, "status", "--json"],
      ["status", "--directory", "alias", "--json"],
    ]) {
      const result = await run(...args);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        workspace: { root: workspace },
        current: { path: main, name: "main" },
      });
    }
  });

  it("resolves init repository and destination paths from the selected directory", async () => {
    const result = await run("-C", root, "init", "./remote.git", "./relative workspace", "--json");
    expect(result.exitCode, result.stderr).toBe(0);
    await expect(
      fs.access(path.join(root, "relative workspace", ".wald", "workspace.yml")),
    ).resolves.toBeUndefined();
  });

  it("uses the selected worktree as the handoff source and preserves its local changes", async () => {
    const readme = path.join(main, "README.md");
    await fs.writeFile(readme, "unfinished work\n");
    const result = await run(
      "-C",
      main,
      "handoff",
      "feature/review",
      "--no-fetch",
      "--skip-hooks",
      "--json",
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).carry.sourcePath).toBe(main);
    expect(await fs.readFile(readme, "utf8")).toBe("unfinished work\n");
    expect(await fs.readFile(path.join(workspace, "feature-review", "README.md"), "utf8")).toBe(
      "unfinished work\n",
    );
  });

  it("does not consume child command arguments after the separator", async () => {
    const args = ["-C", "literal directory", "--directory=literal", "--cd"];
    const result = await run(
      "-C",
      workspace,
      "exec",
      "main",
      "--",
      process.execPath,
      "-e",
      "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}))",
      "--",
      ...args,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ cwd: main, args });
  });

  it("rejects invalid directories before mutation with readable JSON errors", async () => {
    for (const directory of ["absent", path.join(main, "README.md"), ""]) {
      const result = await run(
        "-C",
        directory,
        "create",
        "feature/blocked",
        "--no-fetch",
        "--json",
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).message).toMatch(/Cannot use directory|Cannot be empty/u);
    }
    const missingValue = await run("-C");
    expect(missingValue.exitCode).toBe(1);
    expect(missingValue.stderr).toContain("argument missing");
    await expect(fs.access(path.join(workspace, "feature-blocked"))).rejects.toThrow();
    expect(
      (
        await execa("git", [
          "--git-dir",
          path.join(workspace, "repo.git"),
          "branch",
          "--list",
          "feature/blocked",
        ])
      ).stdout,
    ).toBe("");
  });

  it("does not grant removal confirmation or configuration trust", async () => {
    const removal = await run("-C", workspace, "remove", "main");
    expect(removal.exitCode).toBe(1);
    expect(removal.stderr).toContain("requires --yes");
    await expect(fs.access(main)).resolves.toBeUndefined();
    await fs.writeFile(
      path.join(main, ".wald.yml"),
      "version: 1\ntasks:\n  verify:\n    steps:\n      - type: command\n        argv: [node, --version]\n",
    );
    const task = await run("-C", main, "run", "verify");
    expect(task.exitCode).toBe(1);
    expect(task.stderr).toContain("not trusted");
    expect(await fs.readFile(path.join(workspace, ".wald", "workspace.yml"), "utf8")).toContain(
      "trusted_project_config: null",
    );
  });
});
