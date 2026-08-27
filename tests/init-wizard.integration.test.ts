import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeWorkspace } from "../src/cli/commands/init.js";
import { createCliContext } from "../src/cli/context.js";
import { PromptBackError } from "../src/ui/terminal.js";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

const prompts = vi.hoisted(() => ({
  selections: [] as Array<string | Error>,
  texts: [] as Array<string | Error>,
  confirmations: [] as Array<boolean | Error>,
  choices: [] as Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
  }>,
  textQuestions: [] as string[],
  textDefaults: [] as Array<string | undefined>,
  selectionDefaults: [] as Array<string | undefined>,
  tables: [] as Array<Array<[string, string]>>,
  confirmationQuestions: [] as string[],
}));

vi.mock("../src/ui/terminal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/terminal.js")>();
  return {
    ...actual,
    isInteractiveTerminal: () => true,
    runTask: async <T>(_label: string, task: () => Promise<T>) => await task(),
    selectValue: async (
      question: string,
      options: Array<{ label: string; value: string; description?: string }>,
      promptOptions?: { initialValue?: string },
    ) => {
      prompts.choices.push({
        question,
        options: options.map(({ label, description }) => ({ label, description })),
      });
      prompts.selectionDefaults.push(promptOptions?.initialValue);
      const selection = prompts.selections.shift() ?? null;
      if (selection instanceof Error) throw selection;
      return selection;
    },
    searchSelect: async () => {
      const selection = prompts.selections.shift() ?? null;
      if (selection instanceof Error) throw selection;
      return selection;
    },
    promptText: async (question: string, defaultValue?: string) => {
      prompts.textQuestions.push(question);
      prompts.textDefaults.push(defaultValue);
      if (prompts.texts.length === 0) return defaultValue ?? "";
      const text = prompts.texts.shift();
      if (text instanceof Error) throw text;
      return text as string;
    },
    confirm: async (question: string) => {
      prompts.confirmationQuestions.push(question);
      const confirmation = prompts.confirmations.shift() ?? false;
      if (confirmation instanceof Error) throw confirmation;
      return confirmation;
    },
    printKeyValueTable: async (rows: Array<[string, string]>) => {
      prompts.tables.push(rows);
    },
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
    prompts.textQuestions = [];
    prompts.textDefaults = [];
    prompts.selectionDefaults = [];
    prompts.tables = [];
    prompts.confirmationQuestions = [];
    temporaryRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ygg-init-wizard-test-")),
    );
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
      question: "Initialize › Layout · How should ygg organize this repository?",
      options: expect.arrayContaining([
        expect.objectContaining({
          label: "Create a separate Ygg workspace from committed history (recommended)",
        }),
      ]),
    });
    const workspace = await context.workspaces.find(target);
    expect(workspace.config.remote?.name).toBe("origin");
    expect(await context.worktrees.resolve(workspace, "main")).toMatchObject({
      path: path.join(workspace.root, "main"),
    });
    expect(await fs.readFile(path.join(repository.source, ".git", "config"), "utf8")).toBe(
      sourceConfig,
    );
    expect(prompts.confirmationQuestions).toEqual([
      "Initialize this workspace?",
      "Create this first worktree now?",
      "Configure optional project automation (.ygg.yml) now?",
    ]);
    const rendered = readOutput(output);
    expect(rendered).toContain("Workspace plan");
    expect(rendered).toContain(`${target}${path.sep}  new: workspace root`);
    expect(rendered).toContain(`New worktrees: ${path.join(target, "<branch>")}`);
    expect(rendered).toContain("Optional setup");
    expect(rendered).toContain("Workspace remains initialized; no project config was written.");
  });

  it("recommends retaining a checkout when a worktree is modified", async () => {
    await fs.writeFile(path.join(repository.source, "uncommitted.txt"), "keep me\n", "utf8");
    prompts.selections.push("keep");
    prompts.confirmations.push(true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    expect(prompts.choices[0]).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({
          label: "Keep this checkout as the primary worktree (recommended)",
        }),
      ]),
    });
    expect(prompts.textQuestions[0]).toBe(
      "Initialize › Worktrees · Directory for new worktrees (name or path):",
    );
    expect(prompts.textDefaults[0]).toBe(path.join(temporaryRoot, "source-worktrees"));
    const workspace = await context.workspaces.find(repository.source);
    expect(workspace.primaryWorktree).toBe(await fs.realpath(repository.source));
    expect(workspace.worktreeDir).toBe(path.join(temporaryRoot, "source-worktrees"));
    await expect(
      fs.readFile(path.join(repository.source, "uncommitted.txt"), "utf8"),
    ).resolves.toBe("keep me\n");
  });

  it("resolves a custom worktree directory name beside the retained checkout", async () => {
    prompts.selections.push("keep");
    prompts.texts.push("custom-worktrees");
    prompts.confirmations.push(true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    const workspace = await context.workspaces.find(repository.source);
    expect(workspace.worktreeDir).toBe(path.join(temporaryRoot, "custom-worktrees"));
    expect(prompts.tables[0]).toContainEqual([
      "New worktrees",
      path.join(temporaryRoot, "custom-worktrees"),
    ]);
  });

  it("keeps an absolute worktree path for a local repository selected elsewhere", async () => {
    const worktreesDir = path.join(temporaryRoot, "absolute-worktrees");
    process.chdir(temporaryRoot);
    prompts.selections.push("local", "keep");
    prompts.texts.push(repository.source, worktreesDir);
    prompts.confirmations.push(true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    expect(prompts.textQuestions.slice(0, 2)).toEqual([
      "Initialize › Local · Local repository path:",
      "Initialize › Worktrees · Directory for new worktrees (name or path):",
    ]);
    const workspace = await context.workspaces.find(repository.source);
    expect(workspace.worktreeDir).toBe(worktreesDir);
  });

  it("resolves a relative worktree directory beside a retained bare repository", async () => {
    process.chdir(repository.remote);
    prompts.selections.push("keep");
    prompts.texts.push("bare-worktrees");
    prompts.confirmations.push(true);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    const workspace = await context.workspaces.find(repository.remote);
    expect(workspace.primaryWorktree).toBeNull();
    expect(workspace.worktreeDir).toBe(path.join(temporaryRoot, "bare-worktrees"));
    expect(prompts.choices[0]).toMatchObject({
      question: "Initialize › Layout · How should ygg organize this bare repository?",
      options: expect.arrayContaining([
        expect.objectContaining({ label: "Use this bare repository in place" }),
      ]),
    });
  });

  it("rejects an unsafe guided worktree path before writing metadata", async () => {
    const unsafeDirectory = path.join(repository.source, "nested-worktrees");
    prompts.selections.push("keep");
    prompts.texts.push(unsafeDirectory);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await expect(initializeWorkspace({}, context)).rejects.toThrow(
      /must not be inside an existing worktree/u,
    );

    await expect(fs.stat(path.join(repository.source, ".git", "ygg"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(unsafeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("offers separate remote and local sources outside a Git repository", async () => {
    process.chdir(temporaryRoot);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    expect(readOutput(output)).toContain(
      `No Git repository or ygg workspace found in ${temporaryRoot}.`,
    );
    expect(prompts.choices[0]).toEqual({
      question: "Initialize › Source · How would you like to start?",
      options: [
        {
          label: "Clone a remote repository",
          description: "Use an SSH or HTTPS URL from GitHub, GitLab, or another Git host.",
        },
        {
          label: "Use an existing local repository",
          description: "Use an existing checkout or bare repository on this computer.",
        },
      ],
    });
    expect(prompts.textQuestions).toEqual([]);
    await expect(fs.stat(path.join(temporaryRoot, ".ygg"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("initializes a remote repository through the guided source selection", async () => {
    process.chdir(temporaryRoot);
    const target = path.join(temporaryRoot, "remote-workspace");
    prompts.selections.push("remote", ".");
    prompts.texts.push(`file://${repository.remote}`, target);
    prompts.confirmations.push(true, true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    expect(prompts.textQuestions.slice(0, 2)).toEqual([
      "Initialize › Remote · Remote repository URL (SSH or HTTPS):",
      "Initialize › Destination · Workspace root:",
    ]);
    const workspace = await context.workspaces.find(target);
    expect(workspace.config.remote?.name).toBe("origin");
    expect(await context.worktrees.resolve(workspace, "main")).toMatchObject({
      path: path.join(target, "main"),
    });
    expect(prompts.tables[0]).toContainEqual(["Workspace root", target]);
    expect(prompts.tables[1]).toContainEqual(["New worktree", path.join(target, "main")]);
  });

  it("returns from confirmation to the layout and keeps earlier remote answers", async () => {
    process.chdir(temporaryRoot);
    const target = path.join(temporaryRoot, "remote-after-back");
    prompts.selections.push("remote", ".", ".");
    prompts.texts.push(`file://${repository.remote}`, target);
    prompts.confirmations.push(new PromptBackError(), true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    const layoutCalls = prompts.choices.filter((choice) =>
      choice.question.includes("Where should worktrees be created?"),
    );
    expect(layoutCalls).toHaveLength(2);
    expect(prompts.selectionDefaults.at(-1)).toBe(".");
    const workspace = await context.workspaces.find(target);
    expect(workspace.root).toBe(target);
  });

  it("cancels a remote workspace plan without creating its target", async () => {
    process.chdir(temporaryRoot);
    const target = path.join(temporaryRoot, "cancelled-remote");
    prompts.selections.push("remote", ".");
    prompts.texts.push(`file://${repository.remote}`, target);
    prompts.confirmations.push(false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(prompts.confirmationQuestions).toEqual(["Initialize this workspace?"]);
    expect(readOutput(output)).toContain("Cancelled. No files were changed.");
  });

  it("keeps an initialized workspace when optional first-worktree setup is declined", async () => {
    process.chdir(temporaryRoot);
    const target = path.join(temporaryRoot, "workspace-only");
    prompts.selections.push("remote", ".");
    prompts.texts.push(`file://${repository.remote}`, target);
    prompts.confirmations.push(true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    const workspace = await context.workspaces.find(target);
    expect(await context.worktrees.list(workspace)).toEqual([]);
    expect(readOutput(output)).toContain("Workspace remains initialized; no worktree was created.");
  });

  it("rejects a local path entered in the remote URL flow", async () => {
    process.chdir(temporaryRoot);
    prompts.selections.push("remote");
    prompts.texts.push(repository.remote);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await expect(initializeWorkspace({}, context)).rejects.toThrow(
      /Choose "Use an existing local repository" instead/u,
    );

    expect(prompts.confirmationQuestions).toEqual([]);
  });

  it("rejects an occupied managed target before showing the workspace plan", async () => {
    process.chdir(temporaryRoot);
    const target = path.join(temporaryRoot, "occupied-target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep.txt"), "keep\n", "utf8");
    prompts.selections.push("remote", ".");
    prompts.texts.push(`file://${repository.remote}`, target);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await expect(initializeWorkspace({}, context)).rejects.toThrow(
      /Target directory is not empty/u,
    );

    expect(prompts.confirmationQuestions).toEqual([]);
    expect(readOutput(output)).not.toContain("Workspace plan");
    await expect(fs.readFile(path.join(target, "keep.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("reports an empty remote repository and rolls back the target", async () => {
    process.chdir(temporaryRoot);
    const emptyRemote = path.join(temporaryRoot, "empty.git");
    const target = path.join(temporaryRoot, "empty-workspace");
    await contextGit(["init", "--bare", emptyRemote], temporaryRoot);
    prompts.selections.push("remote", ".");
    prompts.texts.push(`file://${emptyRemote}`, target);
    prompts.confirmations.push(true);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await expect(initializeWorkspace({}, context)).rejects.toThrow(/Repository has no commits/u);

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies a local repository selected from another directory", async () => {
    process.chdir(temporaryRoot);
    const target = path.join(temporaryRoot, "selected-local-workspace");
    prompts.selections.push("local", "copy", ".");
    prompts.texts.push(repository.source, target);
    prompts.confirmations.push(true, true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    expect(prompts.textQuestions[0]).toBe("Initialize › Local · Local repository path:");
    expect(prompts.choices[1]).toMatchObject({
      question: "Initialize › Layout · How should ygg organize this repository?",
      options: expect.arrayContaining([
        expect.objectContaining({
          label: "Create a separate Ygg workspace from committed history (recommended)",
        }),
      ]),
    });
    const workspace = await context.workspaces.find(target);
    expect(workspace.config.remote?.name).toBe("origin");
    expect(await context.worktrees.resolve(workspace, "main")).toMatchObject({
      path: path.join(target, "main"),
    });
  });

  it("cancels a local standalone plan without changing source or target", async () => {
    process.chdir(temporaryRoot);
    const target = path.join(temporaryRoot, "cancelled-copy");
    const sourceConfig = await fs.readFile(path.join(repository.source, ".git", "config"), "utf8");
    prompts.selections.push("local", "copy", ".");
    prompts.texts.push(repository.source, target);
    prompts.confirmations.push(false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(repository.source, ".git", "config"), "utf8")).toBe(
      sourceConfig,
    );
    expect(prompts.tables[0]).toContainEqual([
      "Git object storage",
      "copied independently (no hardlinks)",
    ]);
  });

  it("cancels a retained-checkout plan before writing metadata or creating its container", async () => {
    const worktreesDir = path.join(temporaryRoot, "cancelled-worktrees");
    prompts.selections.push("keep");
    prompts.texts.push(worktreesDir);
    prompts.confirmations.push(false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    await expect(fs.stat(path.join(repository.source, ".git", "ygg"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(worktreesDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readOutput(output)).toContain("Cancelled. No files were changed.");
  });

  it("retains a modified local checkout selected from another directory", async () => {
    await fs.writeFile(path.join(repository.source, "uncommitted.txt"), "keep me\n", "utf8");
    process.chdir(temporaryRoot);
    prompts.selections.push("local", "keep");
    prompts.texts.push(repository.source);
    prompts.confirmations.push(true, false);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    expect(prompts.choices[1]).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({
          label: "Keep this checkout as the primary worktree (recommended)",
        }),
      ]),
    });
    const workspace = await context.workspaces.find(repository.source);
    expect(workspace.primaryWorktree).toBe(await fs.realpath(repository.source));
    await expect(
      fs.readFile(path.join(repository.source, "uncommitted.txt"), "utf8"),
    ).resolves.toBe("keep me\n");
  });

  it("recommends retaining a clean checkout that has a stash", async () => {
    await fs.writeFile(path.join(repository.source, "README.md"), "# stashed\n", "utf8");
    await contextGit(["stash", "push", "-m", "keep me"], repository.source);
    process.chdir(temporaryRoot);
    prompts.selections.push("local");
    prompts.texts.push(repository.source);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await initializeWorkspace({}, context);

    expect(prompts.choices[1]).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({
          label: "Keep this checkout as the primary worktree (recommended)",
        }),
      ]),
    });
    expect((await contextGitOutput(["status", "--porcelain=v1"], repository.source)).stdout).toBe(
      "",
    );
    expect((await contextGitOutput(["stash", "list"], repository.source)).stdout).toContain(
      "keep me",
    );
  });

  it.each([
    ["a missing path", "missing", /Repository path does not exist/u],
    ["a non-Git directory", "plain", /Not a Git repository/u],
  ])("rejects %s without writing workspace metadata", async (_label, name, expected) => {
    process.chdir(temporaryRoot);
    const selectedPath = path.join(temporaryRoot, name);
    if (name === "plain") await fs.mkdir(selectedPath);
    prompts.selections.push("local");
    prompts.texts.push(selectedPath);
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });

    await expect(initializeWorkspace({}, context)).rejects.toThrow(expected);

    await expect(fs.stat(path.join(selectedPath, ".ygg"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recognizes an existing ygg workspace selected from another directory", async () => {
    const target = path.join(temporaryRoot, "existing-workspace");
    const output = new PassThrough();
    const context = createCliContext({ stdout: output, stderr: output });
    const existing = await context.workspaces.initialize(repository.remote, target, temporaryRoot);
    const configBefore = await fs.readFile(existing.configPath, "utf8");
    process.chdir(temporaryRoot);
    prompts.selections.push("local");
    prompts.texts.push(target);

    await initializeWorkspace({}, context);

    expect(await fs.readFile(existing.configPath, "utf8")).toBe(configBefore);
    expect(prompts.choices).toHaveLength(1);
    expect(readOutput(output)).not.toContain("Workspace plan");
  });
});

async function contextGit(args: string[], cwd: string): Promise<void> {
  const { GitClient } = await import("../src/infrastructure/git-client.js");
  await new GitClient().run(args, { cwd });
}

async function contextGitOutput(args: string[], cwd: string) {
  const { GitClient } = await import("../src/infrastructure/git-client.js");
  return await new GitClient().run(args, { cwd });
}

function readOutput(output: PassThrough): string {
  return output.read()?.toString() ?? "";
}
