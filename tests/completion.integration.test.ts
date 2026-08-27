import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRemoteBranch,
  createTestRepository,
  type TestRepository,
} from "./helpers/git-repository.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "src", "cli.ts");
const tsxLoader = import.meta.resolve("tsx");

function cliArguments(...args: string[]): string[] {
  return ["--import", tsxLoader, cli, ...args];
}

async function runCli(cwd: string, ...args: string[]) {
  return await execa(process.execPath, cliArguments(...args), { cwd, reject: false });
}

function suggestionValues(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith(":"))
    .map((line) => line.split("\t")[0] as string);
}

describe("shell completion scripts", () => {
  it.each(["zsh", "bash", "fish"])("generates the complete %s integration", async (shell) => {
    const result = await runCli(projectRoot, "completion", shell);

    expect(result.exitCode, result.stderr).toBe(0);
    const normalizedOutput = result.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
    expect(normalizedOutput).toMatchSnapshot();
  });

  it("keeps PowerShell outside the supported command surface", async () => {
    const result = await runCli(projectRoot, "completion", "powershell");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Allowed choices are zsh, bash, fish");
  });
});

describe("dynamic shell completion", () => {
  let temporaryRoot: string;
  let repository: TestRepository;
  let workspace: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-completion-test-"));
    repository = await createTestRepository(temporaryRoot);
    await createRemoteBranch(repository, "feature/remote");
    workspace = path.join(temporaryRoot, "workspace");

    const initialized = await runCli(temporaryRoot, "init", repository.remote, workspace);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    await execa(
      "git",
      [
        `--git-dir=${path.join(workspace, "repo.git")}`,
        "update-ref",
        "-d",
        "refs/heads/feature/remote",
      ],
      { cwd: workspace },
    );
    const main = await runCli(workspace, "create", "main", "--no-fetch");
    expect(main.exitCode, main.stderr).toBe(0);
    const feature = await runCli(workspace, "create", "feature/local", "--no-fetch");
    expect(feature.exitCode, feature.stderr).toBe(0);

    const projectConfig = `version: 1
tasks:
  verify:
    description: Verify configured project
    steps:
      - type: command
        argv: [node, --version]
tools:
  fixture-agent:
    description: Fixture agent
    command: [node, --version]
    mode: foreground
`;
    await Promise.all([
      fs.writeFile(path.join(workspace, "main", ".ygg.yml"), projectConfig, "utf8"),
      fs.writeFile(path.join(workspace, "feature-local", ".ygg.yml"), projectConfig, "utf8"),
    ]);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("completes static commands and options without workspace data", async () => {
    const commands = await runCli(temporaryRoot, "complete", "--", "");
    const options = await runCli(temporaryRoot, "complete", "--", "create", "--");
    const shells = await runCli(temporaryRoot, "complete", "--", "completion", "");

    expect(commands.exitCode, commands.stderr).toBe(0);
    expect(suggestionValues(commands.stdout)).toEqual(
      expect.arrayContaining(["init", "create", "config", "completion"]),
    );
    expect(suggestionValues(commands.stdout)).not.toContain("complete");
    expect(suggestionValues(commands.stdout)).not.toContain("shell-init");
    expect(suggestionValues(options.stdout)).toEqual(
      expect.arrayContaining(["--from", "--name", "--tool", "--help"]),
    );
    expect(suggestionValues(shells.stdout)).toEqual(["zsh", "bash", "fish"]);
  });

  it("completes branches and worktrees with descriptions", async () => {
    const branches = await runCli(workspace, "complete", "--", "create", "");

    expect(branches.exitCode, branches.stderr).toBe(0);
    expect(branches.stdout).toContain("feature/local\tlocal branch");
    expect(branches.stdout).toContain("feature/remote\torigin branch");
    expect(branches.stdout.match(/^main\t/gmu)).toHaveLength(1);

    for (const command of ["cd", "open", "setup", "remove", "exec"]) {
      const worktrees = await runCli(workspace, "complete", "--", command, "");
      expect(worktrees.exitCode, worktrees.stderr).toBe(0);
      expect(worktrees.stdout).toMatch(/feature-local\tfeature\/local \(modified\)/u);
      expect(worktrees.stdout).toMatch(/main\tmain \(modified\)/u);
    }
  });

  it("completes configured tasks, worktree positions, and available tools", async () => {
    const tasks = await runCli(workspace, "complete", "--", "run", "");
    const runWorktree = await runCli(workspace, "complete", "--", "run", "verify", "");
    const configWorktree = await runCli(workspace, "complete", "--", "config", "init", "");

    expect(tasks.exitCode, tasks.stderr).toBe(0);
    expect(tasks.stdout).toContain("verify\tVerify configured project");
    expect(suggestionValues(runWorktree.stdout)).toEqual(
      expect.arrayContaining(["main", "feature-local"]),
    );
    expect(suggestionValues(configWorktree.stdout)).toEqual(
      expect.arrayContaining(["main", "feature-local"]),
    );
    for (const command of ["create", "open"]) {
      const tools = await runCli(workspace, "complete", "--", command, "--tool", "");
      expect(tools.exitCode, tools.stderr).toBe(0);
      expect(tools.stdout).toContain("fixture-agent\tFixture agent");
    }
  });
});
