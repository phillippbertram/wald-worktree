import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/create-program.js";

describe("CLI contract", () => {
  it("exposes only the intentional clean-break command surface", () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    expect(program.name()).toBe("ygg");
    expect(program.commands.map((command) => command.name())).toEqual([
      "init",
      "create",
      "status",
      "list",
      "cd",
      "open",
      "exec",
      "run",
      "hook",
      "setup",
      "remove",
      "prune",
      "uninit",
      "config",
      "completion",
      "complete",
    ]);
    const completion = program.commands.find((command) => command.name() === "completion");
    const complete = program.commands.find((command) => command.name() === "complete");
    expect(completion?.registeredArguments[0]?.argChoices).toEqual(["zsh", "bash", "fish"]);
    expect(complete?.helpInformation()).toContain("Generate completion suggestions");
    expect(program.helpInformation()).not.toContain("complete --");
    expect(program.helpInformation()).not.toContain("shell-init");
    expect(program.commands.find((command) => command.name() === "config")?.commands).toHaveLength(
      3,
    );
  });

  it("requires --apply when prune confirmation is passed", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(program.parseAsync(["node", "ygg", "prune", "--yes"])).rejects.toThrow(
      /--yes: Requires --apply/u,
    );
  });

  it("requires --apply for uninitialization confirmation and force", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(program.parseAsync(["node", "ygg", "uninit", "--yes"])).rejects.toThrow(
      /--yes: Requires --apply/u,
    );
    await expect(program.parseAsync(["node", "ygg", "uninit", "--force"])).rejects.toThrow(
      /--force: Requires --apply/u,
    );
  });

  it("validates Commander input through a readable Zod boundary before services run", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "ygg", "create", "main", "--name", ""]),
    ).rejects.toThrow(
      /Invalid command input:[\s\S]*--name: Cannot be empty\.[\s\S]*Run with --help/u,
    );
  });

  it("rejects multiple post-create destinations before touching a workspace", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "ygg", "create", "feature/review", "--cd", "--tool", "codex"]),
    ).rejects.toThrow(/--cd: Cannot be combined with --open or --tool/u);
  });

  it("validates project configuration scope combinations before workspace discovery", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "ygg", "init", "--config-scope", "project"]),
    ).rejects.toThrow(/--config-scope: Requires --config/u);
    await expect(
      program.parseAsync(["node", "ygg", "config", "init", "--scope", "project", "--from-project"]),
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
    const openHelp = captureHelp(open);
    const configInitHelp = captureHelp(configInit);
    const hookRunHelp = captureHelp(hookRun);

    expect(rootHelp).toContain("Usage: ygg");
    expect(rootHelp).toContain("🌳 Create and work in isolated Git checkouts safely.");
    expect(rootHelp).toContain("🌱 Start here:");
    expect(rootHelp).toContain("cd ~/dev/project && ygg init");
    expect(initHelp).toContain(
      "Keep an existing checkout or create a standalone workspace (Ygg Flow by default)",
    );
    expect(initHelp).toContain("defaults to the Ygg Flow root");
    expect(initHelp).toContain("cloned repositories");
    expect(initHelp).toContain("--config-scope <scope>");
    expect(createHelp).toContain("ygg create feature/payment --cd");
    expect(createHelp).toContain("codex-app");
    expect(openHelp).toContain("ygg open feature-payment --tool code");
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
});
