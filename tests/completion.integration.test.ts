import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
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
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wald-completion-test-"));
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
      fs.writeFile(path.join(workspace, "main", ".wald.yml"), projectConfig, "utf8"),
      fs.writeFile(path.join(workspace, "feature-local", ".wald.yml"), projectConfig, "utf8"),
      fs.writeFile(
        path.join(workspace, ".wald", "project.yml"),
        `version: 1
tasks:
  local-check:
    description: Local workspace check
    steps:
      - type: command
        argv: [node, --version]
tools:
  local-agent:
    description: Local workspace agent
    command: [node, --version]
`,
        "utf8",
      ),
    ]);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("completes static commands and options without workspace data", async () => {
    const commands = await runCli(temporaryRoot, "complete", "--", "");
    const options = await runCli(temporaryRoot, "complete", "--", "create", "--");
    const doctorOptions = await runCli(temporaryRoot, "complete", "--", "doctor", "--");
    const removeOptions = await runCli(temporaryRoot, "complete", "--", "remove", "--");
    const shells = await runCli(temporaryRoot, "complete", "--", "completion", "");
    const configScopes = await runCli(
      temporaryRoot,
      "complete",
      "--",
      "config",
      "init",
      "--scope",
      "",
    );

    expect(commands.exitCode, commands.stderr).toBe(0);
    expect(suggestionValues(commands.stdout)).toEqual(
      expect.arrayContaining([
        "init",
        "create",
        "plant",
        "handoff",
        "doctor",
        "status",
        "ls",
        "rename",
        "config",
        "completion",
      ]),
    );
    expect(suggestionValues(commands.stdout)).not.toContain("complete");
    expect(suggestionValues(commands.stdout)).not.toContain("shell-init");
    const aliasOptions = await runCli(temporaryRoot, "complete", "--", "ls", "--");
    expect(suggestionValues(aliasOptions.stdout)).toEqual(expect.arrayContaining(["--json"]));
    expect(suggestionValues(options.stdout)).toEqual(
      expect.arrayContaining(["--from", "--name", "--carry", "--tool", "--json", "--help"]),
    );
    const plantOptions = await runCli(temporaryRoot, "complete", "--", "plant", "--");
    expect(suggestionValues(plantOptions.stdout)).toEqual(
      expect.arrayContaining(["--from", "--name", "--carry", "--tool", "--json", "--help"]),
    );
    expect(suggestionValues(doctorOptions.stdout)).toEqual(
      expect.arrayContaining(["--json", "--verbose", "--help"]),
    );
    expect(suggestionValues(removeOptions.stdout)).toEqual(
      expect.arrayContaining(["--delete-branch", "--force", "--yes", "--json", "--help"]),
    );
    expect(suggestionValues(shells.stdout)).toEqual(["zsh", "bash", "fish"]);
    expect(suggestionValues(configScopes.stdout)).toEqual(["workspace", "project"]);
  });

  it("completes branches and worktrees with descriptions", async () => {
    const branches = await runCli(workspace, "complete", "--", "create", "");
    const plantBranches = await runCli(workspace, "complete", "--", "plant", "");
    const carryBranches = await runCli(workspace, "complete", "--", "create", "--carry", "");
    const handoffBranches = await runCli(workspace, "complete", "--", "handoff", "");
    const hookEvents = await runCli(workspace, "complete", "--", "hook", "run", "");
    const hookWorktrees = await runCli(
      workspace,
      "complete",
      "--",
      "hook",
      "run",
      "post_create",
      "",
    );

    expect(branches.exitCode, branches.stderr).toBe(0);
    expect(branches.stdout).toContain("feature/local\tlocal branch");
    expect(branches.stdout).toContain("feature/remote\torigin branch");
    expect(branches.stdout.match(/^main\t/gmu)).toHaveLength(1);
    expect(plantBranches.stdout).toBe(branches.stdout);
    expect(suggestionValues(carryBranches.stdout)).not.toEqual(
      expect.arrayContaining(["main", "feature/local", "feature/remote"]),
    );
    expect(suggestionValues(handoffBranches.stdout)).not.toEqual(
      expect.arrayContaining(["main", "feature/local", "feature/remote"]),
    );
    expect(suggestionValues(hookEvents.stdout)).toEqual([
      "pre_create",
      "post_create",
      "pre_remove",
      "post_remove",
    ]);
    expect(suggestionValues(hookWorktrees.stdout)).toEqual(
      expect.arrayContaining(["main", "feature-local"]),
    );

    for (const command of ["cd", "open", "setup", "rename", "remove", "exec"]) {
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
    expect(tasks.stdout).toContain("local-check\tLocal workspace check");
    expect(suggestionValues(runWorktree.stdout)).toEqual(
      expect.arrayContaining(["main", "feature-local"]),
    );
    expect(suggestionValues(configWorktree.stdout)).toEqual(
      expect.arrayContaining(["main", "feature-local"]),
    );
    for (const command of ["create", "handoff", "open"]) {
      const tools = await runCli(workspace, "complete", "--", command, "--tool", "");
      expect(tools.exitCode, tools.stderr).toBe(0);
      expect(tools.stdout).toContain("fixture-agent\tFixture agent");
      expect(tools.stdout).toContain("local-agent\tLocal workspace agent");
    }
  });

  it("colors human-readable output without formatting JSON", async () => {
    const env = { FORCE_COLOR: "1", NO_COLOR: undefined };
    const colored = await execa(process.execPath, cliArguments("list"), {
      cwd: workspace,
      env,
      reject: false,
    });
    const json = await execa(process.execPath, cliArguments("list", "--json"), {
      cwd: workspace,
      env,
      reject: false,
    });

    expect(colored.exitCode, colored.stderr).toBe(0);
    expect(colored.stdout).toContain("\u001B[");
    expect(stripVTControlCharacters(colored.stdout)).toContain("main\tmain\tlinked\tmodified");
    expect(json.exitCode, json.stderr).toBe(0);
    expect(json.stdout).not.toContain("\u001B[");
    expect(JSON.parse(json.stdout)).toEqual(expect.arrayContaining([expect.any(Object)]));
  });
});
