import { PassThrough } from "node:stream";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import { createProgram } from "../src/cli/create-program.js";
import { cliArguments, cliExecutable, projectRoot } from "./helpers/cli.js";

describe("CLI contract", () => {
  it("exposes only the intentional clean-break command surface", () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    expect(program.name()).toBe("wald");
    expect(program.commands.map((command) => command.name())).toEqual([
      "init",
      "create",
      "handoff",
      "doctor",
      "status",
      "list",
      "cd",
      "path",
      "open",
      "exec",
      "run",
      "hook",
      "setup",
      "rename",
      "remove",
      "prune",
      "uninit",
      "config",
      "completion",
      "complete",
    ]);
    const completion = program.commands.find((command) => command.name() === "completion");
    const complete = program.commands.find((command) => command.name() === "complete");
    expect(program.commands.find((command) => command.name() === "list")?.aliases()).toEqual([
      "ls",
    ]);
    expect(program.commands.find((command) => command.name() === "create")?.aliases()).toEqual([
      "plant",
    ]);
    expect(completion?.registeredArguments[0]?.argChoices).toEqual(["zsh", "bash", "fish"]);
    expect(complete?.helpInformation()).toContain("Generate completion suggestions");
    expect(program.helpInformation()).not.toContain("complete --");
    expect(program.helpInformation()).not.toContain("shell-init");
    expect(program.commands.find((command) => command.name() === "config")?.commands).toHaveLength(
      3,
    );
    expect(
      program.commands
        .find((command) => command.name() === "doctor")
        ?.options.map((option) => option.long),
    ).toEqual(["--json", "--verbose"]);
  });

  it("requires --apply when prune confirmation is passed", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(program.parseAsync(["node", "wald", "prune", "--yes"])).rejects.toThrow(
      /--yes: Requires --apply/u,
    );
  });

  it("documents the rename default and rejects conflicting or empty branch options", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });
    const rename = program.commands.find((command) => command.name() === "rename");
    expect(rename?.description()).toBe("Rename a linked worktree directory and its local branch");
    expect(rename?.helpInformation()).toContain("--branch <new-branch>");
    expect(rename?.helpInformation()).toContain("--keep-branch");
    await expect(
      program.parseAsync([
        "node",
        "wald",
        "rename",
        "feature",
        "review",
        "--branch",
        "other",
        "--keep-branch",
      ]),
    ).rejects.toThrow(/Cannot be combined with --keep-branch/u);
    await expect(
      program.parseAsync(["node", "wald", "rename", "feature", "review", "--branch", ""]),
    ).rejects.toThrow(/Cannot be empty/u);
  });

  it("requires --apply for uninitialization confirmation and force", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(program.parseAsync(["node", "wald", "uninit", "--yes"])).rejects.toThrow(
      /--yes: Requires --apply/u,
    );
    await expect(program.parseAsync(["node", "wald", "uninit", "--force"])).rejects.toThrow(
      /--force: Requires --apply/u,
    );
  });

  it("validates Commander input through a readable Zod boundary before services run", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "wald", "create", "main", "--name", ""]),
    ).rejects.toThrow(
      /Invalid command input:[\s\S]*--name: Cannot be empty\.[\s\S]*Run with --help/u,
    );
  });

  it("routes the plant alias through the create command contract", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "wald", "plant", "main", "--name", ""]),
    ).rejects.toThrow(
      /Invalid command input:[\s\S]*--name: Cannot be empty\.[\s\S]*Run with --help/u,
    );
  });

  it("rejects multiple post-create destinations before touching a workspace", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "wald", "create", "feature/review", "--cd", "--tool", "codex"]),
    ).rejects.toThrow(/--cd: Cannot be combined with --open or --tool/u);
  });

  it("rejects incompatible carry options before touching a workspace", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "wald", "create", "feature/review", "--carry", "--from", "main"]),
    ).rejects.toThrow(/--carry: Cannot be combined with --from/u);
  });

  it("validates project configuration scope combinations before workspace discovery", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "wald", "init", "--config-scope", "project"]),
    ).rejects.toThrow(/--config-scope: Requires --config/u);
    await expect(
      program.parseAsync([
        "node",
        "wald",
        "config",
        "init",
        "--scope",
        "project",
        "--from-project",
      ]),
    ).rejects.toThrow(/--from-project: Requires --scope workspace/u);
  });

  it("exposes creation, configuration, and hook arguments in command help", () => {
    const program = createProgram();
    const command = (name: string) => program.commands.find((item) => item.name() === name);
    const create = command("create")?.helpInformation();
    const handoff = command("handoff")?.helpInformation();
    expect(create).toContain("create|plant [options] [branch]");
    expect(handoff).toContain("handoff [options] [branch]");
    for (const help of [create, handoff]) {
      expect(help).toContain("--skip-hooks");
      expect(help).toContain("--json");
    }
    for (const flag of ["--carry", "--from"]) {
      expect(create).toContain(flag);
      expect(handoff).not.toContain(flag);
    }
    expect(command("init")?.helpInformation()).toContain("--config-scope <scope>");
    const configInit = command("config")?.commands.find((item) => item.name() === "init");
    expect(configInit?.helpInformation()).toContain("--scope <scope>");
    expect(configInit?.helpInformation()).toContain("--from-project");
    const hookRun = command("hook")?.commands.find((item) => item.name() === "run");
    expect(hookRun?.helpInformation()).toContain("<event> [worktree]");
    expect(hookRun?.registeredArguments[0]?.argChoices).toEqual([
      "pre_create",
      "post_create",
      "pre_remove",
      "post_remove",
    ]);
  });

  it("shows help and exits when started without a terminal", async () => {
    const result = await execa(cliExecutable, cliArguments(), { cwd: projectRoot });

    expect(result.stdout).toContain("Usage: wald");
    expect(result.stderr).toBe("");
  });

  it("reports the package version", async () => {
    const result = await execa(cliExecutable, cliArguments("--version"), { cwd: projectRoot });

    expect(result.stdout).toBe(manifest.version);
  });
});
