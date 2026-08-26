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
      2,
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
});
