import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/create-program.js";

describe("CLI contract", () => {
  it("exposes only the intentional clean-break command surface", () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    expect(program.commands.map((command) => command.name())).toEqual([
      "init",
      "create",
      "list",
      "cd",
      "open",
      "exec",
      "run",
      "setup",
      "remove",
      "config",
      "shell-init",
      "completion",
    ]);
    expect(program.commands.find((command) => command.name() === "config")?.commands).toHaveLength(
      3,
    );
  });

  it("validates Commander input through a readable Zod boundary before services run", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "wt", "create", "main", "--name", ""]),
    ).rejects.toThrow(
      /Invalid command input:[\s\S]*--name: Cannot be empty\.[\s\S]*Run with --help/u,
    );
  });

  it("rejects multiple post-create destinations before touching a workspace", async () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });

    await expect(
      program.parseAsync(["node", "wt", "create", "feature/review", "--cd", "--tool", "codex"]),
    ).rejects.toThrow(/--cd: Cannot be combined with --open or --tool/u);
  });

  it("keeps onboarding and built-in tools discoverable in help", () => {
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });
    const create = program.commands.find((command) => command.name() === "create");
    const open = program.commands.find((command) => command.name() === "open");

    program.outputHelp();
    const rootHelp = output.read()?.toString() ?? "";
    create?.outputHelp();
    const createHelp = output.read()?.toString() ?? "";
    open?.outputHelp();
    const openHelp = output.read()?.toString() ?? "";

    expect(rootHelp).toContain("cd ~/dev/project && wt init");
    expect(createHelp).toContain("wt create feature/payment --cd");
    expect(createHelp).toContain("codex-app");
    expect(openHelp).toContain("wt open feature-payment --tool code");
  });
});
