import path from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/create-program.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "src", "cli.ts");
const tsxLoader = import.meta.resolve("tsx");

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

  it("keeps onboarding and built-in tools discoverable in help", () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });
    const init = program.commands.find((command) => command.name() === "init");
    const configInit = program.commands
      .find((command) => command.name() === "config")
      ?.commands.find((command) => command.name() === "init");
    const hookRun = program.commands
      .find((command) => command.name() === "hook")
      ?.commands.find((command) => command.name() === "run");
    const create = program.commands.find((command) => command.name() === "create");
    const handoff = program.commands.find((command) => command.name() === "handoff");
    const doctor = program.commands.find((command) => command.name() === "doctor");
    const open = program.commands.find((command) => command.name() === "open");
    let captured = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      captured += chunk;
    });
    const captureHelp = (command: typeof program | undefined): string => {
      captured = "";
      command?.outputHelp();
      return captured;
    };

    const rootHelp = captureHelp(program);
    const initHelp = captureHelp(init);
    const createHelp = captureHelp(create);
    const handoffHelp = captureHelp(handoff);
    const doctorHelp = captureHelp(doctor);
    const openHelp = captureHelp(open);
    const configInitHelp = captureHelp(configInit);
    const hookRunHelp = captureHelp(hookRun);

    expect(rootHelp).toContain("Usage: wald");
    expect(rootHelp).toContain(
      "🌲 Where Git worktrees grow — safe, guided workspaces for parallel work.",
    );
    expect(rootHelp).toContain("🌱 Start here:");
    expect(rootHelp).toContain("cd ~/dev/project && wald init");
    expect(initHelp.replace(/\s+/gu, " ")).toContain(
      "Keep an existing checkout or create a standalone workspace (Wald Flow by default)",
    );
    expect(initHelp).toContain("defaults to the Wald Flow root");
    expect(initHelp).toContain("cloned repositories");
    expect(initHelp).toContain("--config-scope <scope>");
    expect(createHelp).toContain("wald create feature/payment --cd");
    expect(createHelp).toContain("--carry");
    expect(createHelp).toContain("--json");
    expect(createHelp).toContain("codex-app");
    expect(handoffHelp).toContain("code state only");
    expect(handoffHelp).toContain("does not move a running editor, process, or agent session");
    expect(handoffHelp).toContain("--json");
    expect(doctorHelp).toContain("Diagnose the runtime, workspace, Git state");
    expect(openHelp).toContain("wald open feature-payment --tool code");
    expect(configInitHelp).toContain("--scope <scope>");
    expect(configInitHelp).toContain("--from-project");
    expect(hookRunHelp).toContain("<event> [worktree]");
    expect(hookRun?.registeredArguments[0]?.argChoices).toEqual([
      "pre_create",
      "post_create",
      "pre_remove",
      "post_remove",
    ]);
  });

  it("colors root and subcommand help while respecting NO_COLOR", async () => {
    const helpArguments = ["--import", tsxLoader, cli];
    const [root, subcommand, plain] = await Promise.all([
      execa(process.execPath, [...helpArguments, "--help"], {
        cwd: projectRoot,
        env: { FORCE_COLOR: "1", NO_COLOR: undefined },
      }),
      execa(process.execPath, [...helpArguments, "create", "--help"], {
        cwd: projectRoot,
        env: { FORCE_COLOR: "1", NO_COLOR: undefined },
      }),
      execa(process.execPath, [...helpArguments, "--help"], {
        cwd: projectRoot,
        env: { FORCE_COLOR: undefined, NO_COLOR: "1" },
      }),
    ]);

    expect(root.stdout).toContain("\u001B[");
    expect(subcommand.stdout).toContain("\u001B[");
    expect(stripVTControlCharacters(root.stdout)).toContain("Usage: wald");
    expect(stripVTControlCharacters(subcommand.stdout)).toContain("Usage: wald create");
    expect(plain.stdout).not.toContain("\u001B[");
    expect(plain.stdout).toContain("Usage: wald");
  });
});
