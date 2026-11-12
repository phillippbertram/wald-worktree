import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCompletionRequest } from "../src/cli/completion-request.js";
import { decodeCompletionWord } from "../src/cli/completion-word.js";
import { createProgram } from "../src/cli/create-program.js";

const menu = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/cli/main-menu.js", () => ({ runMainMenu: menu }));

describe("directory option parsing", () => {
  const originalCwd = process.cwd();
  let root: string | undefined;

  afterEach(async () => {
    process.chdir(originalCwd);
    if (root) await fs.rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("opens the guided menu after applying the directory and exposes the global option", async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wald-directory-menu-")));
    const output = new PassThrough();
    const program = createProgram({ stdout: output, stderr: output });
    menu.mockImplementationOnce(async () => {
      expect(process.cwd()).toBe(root);
    });
    expect(program.helpInformation()).toContain("-C, --directory <path>");
    expect(
      program.commands.find((command) => command.name() === "status")?.helpInformation(),
    ).toContain("-C, --directory <path>");
    await program.parseAsync(["-C", root], { from: "user" });
    expect(menu).toHaveBeenCalledOnce();
  });

  it("leaves cwd unchanged when a later directory is invalid", async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wald-directory-error-")));
    const program = createProgram();
    await expect(
      program.parseAsync(["-C", root, "-C", "absent"], { from: "user" }),
    ).rejects.toThrow("Cannot use directory");
    expect(process.cwd()).toBe(originalCwd);
    expect(menu).not.toHaveBeenCalled();
  });

  it("keeps option values and child arguments distinct from directory options during completion", () => {
    const program = createProgram();
    expect(
      parseCompletionRequest(
        ["-C", "one", "create", "--name", "-Ctwo", "--directory=three", ""],
        program,
      ),
    ).toMatchObject({ directories: ["one", "three"], args: ["create", "--name", "-Ctwo", ""] });
    expect(
      parseCompletionRequest(["-Cone", "exec", "main", "--", "tool", "-Ctwo", ""], program),
    ).toMatchObject({ directories: ["one"], afterSeparator: true });
    expect(parseCompletionRequest(["-C", "one", "--directory", "two/"], program)).toMatchObject({
      directories: ["one"],
      directoryInput: { value: "two/", prefix: "" },
    });
  });
});

describe("completion word quoting", () => {
  it.each([
    [String.raw`directory\ with\ spaces`, "directory with spaces"],
    ['"directory with spaces"', "directory with spaces"],
    ["'directory with spaces'", "directory with spaces"],
    ['"unfinished directory', "unfinished directory"],
    [String.raw`'literal\path'`, String.raw`literal\path`],
    [String.raw`"literal\path"`, String.raw`literal\path`],
    [String.raw`"literal\"quote"`, 'literal"quote'],
    ['"$(touch marker) $PWD"', "$(touch marker) $PWD"],
  ])("decodes %s without evaluating its contents", (input, expected) => {
    expect(decodeCompletionWord(input)).toBe(expected);
  });
});
