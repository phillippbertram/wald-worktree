import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeWorkspace } from "../src/cli/commands/init.js";
import { createCliContext } from "../src/cli/context.js";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

const prompts = vi.hoisted(() => ({
  selections: [] as string[],
  texts: [] as string[],
  confirmations: [] as boolean[],
  choices: [] as Array<{ question: string; labels: string[] }>,
}));

vi.mock("../src/ui/terminal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/terminal.js")>();
  return {
    ...actual,
    isInteractiveTerminal: () => true,
    runTask: async <T>(_label: string, task: () => Promise<T>) => await task(),
    selectValue: async (question: string, options: Array<{ label: string; value: string }>) => {
      prompts.choices.push({
        question,
        labels: options.map((option) => option.label),
      });
      return prompts.selections.shift() ?? null;
    },
    searchSelect: async () => prompts.selections.shift() ?? null,
    promptText: async () => prompts.texts.shift() ?? "",
    confirm: async () => prompts.confirmations.shift() ?? false,
    printKeyValueTable: async () => undefined,
    printStatus: async () => undefined,
  };
});

describe("interactive init wizard", () => {
  let temporaryRoot: string;
  let repository: TestRepository;
  let previousCwd: string;

  beforeEach(async () => {
    prompts.selections = [];
    prompts.texts = [];
    prompts.confirmations = [];
    prompts.choices = [];
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wt-init-wizard-test-"));
    repository = await createTestRepository(temporaryRoot);
    previousCwd = process.cwd();
    process.chdir(repository.source);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("recommends and completes a standalone root for a clean repository", async () => {
    const target = path.join(temporaryRoot, "standalone");
    const sourceConfig = await fs.readFile(path.join(repository.source, ".git", "config"), "utf8");
    prompts.selections.push("copy", ".");
    prompts.texts.push(target);
    prompts.confirmations.push(true, true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    expect(prompts.choices[0]).toMatchObject({
      question: "How should wt organize this repository?",
      labels: expect.arrayContaining(["Create a new workspace root (recommended)"]),
    });
    const workspace = await context.workspaces.find(target);
    expect(workspace.config.remote?.name).toBe("origin");
    expect(await context.worktrees.resolve(workspace, "main")).toMatchObject({
      path: path.join(workspace.root, "main"),
    });
    expect(await fs.readFile(path.join(repository.source, ".git", "config"), "utf8")).toBe(
      sourceConfig,
    );
  });

  it("recommends retaining a checkout when a worktree is modified", async () => {
    await fs.writeFile(path.join(repository.source, "uncommitted.txt"), "keep me\n", "utf8");
    prompts.selections.push("keep");
    prompts.confirmations.push(true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    expect(prompts.choices[0]).toMatchObject({
      labels: expect.arrayContaining(["Keep this checkout (recommended)"]),
    });
    const workspace = await context.workspaces.find(repository.source);
    expect(workspace.primaryWorktree).toBe(await fs.realpath(repository.source));
    await expect(
      fs.readFile(path.join(repository.source, "uncommitted.txt"), "utf8"),
    ).resolves.toBe("keep me\n");
  });

  it("creates a standalone root from a repository without a remote", async () => {
    await contextGit(["remote", "remove", "origin"], repository.source);
    const target = path.join(temporaryRoot, "local-only");
    prompts.selections.push("copy", "worktrees");
    prompts.texts.push(target);
    prompts.confirmations.push(true, true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    const workspace = await context.workspaces.find(target);
    expect(workspace.config.remote).toBeNull();
    expect(await context.worktrees.resolve(workspace, "main")).toMatchObject({
      path: path.join(workspace.root, "worktrees", "main"),
    });
  });
});

async function contextGit(args: string[], cwd: string): Promise<void> {
  const { GitClient } = await import("../src/infrastructure/git-client.js");
  await new GitClient().run(args, { cwd });
}
