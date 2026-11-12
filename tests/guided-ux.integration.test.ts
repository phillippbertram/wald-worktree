import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorktree } from "../src/cli/commands/create.js";
import { removeWorktrees } from "../src/cli/commands/remove.js";
import { renameWorktree } from "../src/cli/commands/rename.js";
import { runProjectTask } from "../src/cli/commands/run.js";
import { createCliContext } from "../src/cli/context.js";
import type { Workspace, Worktree } from "../src/domain/types.js";
import { PromptBackError } from "../src/ui/terminal.js";
import { createTestRepository } from "./helpers/git-repository.js";

const prompts = vi.hoisted(() => ({
  selections: [] as Array<string | Error>,
  searches: [] as string[],
  texts: [] as string[],
  branches: [] as string[][],
  branchDefaults: [] as string[][],
  choices: [] as Array<Array<{ value: string; label: string; disabled?: boolean }>>,
}));

vi.mock("../src/ui/terminal.js", async (original) => ({
  ...(await original<typeof import("../src/ui/terminal.js")>()),
  isInteractiveTerminal: () => true,
  runTask: async <T>(_label: string, task: () => Promise<T>) => task(),
  printStatus: async () => undefined,
  selectValue: async (
    _question: string,
    choices: Array<{ value: string; label: string; disabled?: boolean }>,
  ) => {
    prompts.choices.push(choices);
    const value = prompts.selections.shift();
    if (value instanceof Error) throw value;
    if (!choices.some((choice) => choice.value === value))
      throw new Error(`Selection not offered: ${value}`);
    return value;
  },
  searchSelect: async (
    _question: string,
    choices: Array<{ value: string; label: string; disabled?: boolean }>,
  ) => {
    prompts.choices.push(choices);
    const value = prompts.searches.shift();
    if (!value) throw new Error("Missing search answer");
    return value;
  },
  promptText: async (
    _question: string,
    _initial: string | undefined,
    options: { validateAsync?: (value: string) => Promise<void> },
  ) => {
    const value = prompts.texts.shift();
    if (value === undefined) throw new Error("Missing text answer");
    await options.validateAsync?.(value);
    return value;
  },
  selectManyValues: async (
    _question: string,
    _choices: unknown,
    options: { initialValues?: string[] },
  ) => {
    prompts.branchDefaults.push([...(options.initialValues ?? [])]);
    return prompts.branches.shift() ?? [];
  },
}));

describe("guided UX with real worktrees", () => {
  let root: string;
  let context: ReturnType<typeof createCliContext>;
  let workspace: Workspace;
  let feature: Worktree;

  beforeEach(async () => {
    prompts.selections = [];
    prompts.searches = [];
    prompts.texts = [];
    prompts.branches = [];
    prompts.branchDefaults = [];
    prompts.choices = [];
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wald-guided-ux-")));
    const repository = await createTestRepository(root);
    const output = new PassThrough();
    context = createCliContext({ stdout: output, stderr: output });
    workspace = await context.workspaces.initialize(
      repository.remote,
      path.join(root, "workspace"),
      root,
    );
    vi.spyOn(context.workspaces, "find").mockResolvedValue(workspace);
    feature = await context.worktrees.add(workspace, { branch: "feature/topic", fetch: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["cancel", "keep", "delete"])(
    "preserves exactly the state named by the removal action: %s",
    async (action) => {
      prompts.selections.push(action);
      await removeWorktrees(
        { worktrees: [feature.path], force: false, deleteBranch: false, yes: false },
        context,
      );
      expect(await exists(feature.path)).toBe(action === "cancel");
      expect(
        await context.git.succeeds(["show-ref", "--verify", "refs/heads/feature/topic"], {
          gitDir: workspace.gitDir,
        }),
      ).toBe(action !== "delete");
      if (action === "cancel")
        expect(await fs.readFile(path.join(feature.path, "README.md"), "utf8")).toContain(
          "fixture",
        );
    },
  );

  it("blocks a dirty worktree before offering a destructive action", async () => {
    const readme = path.join(feature.path, "README.md");
    await fs.writeFile(readme, "local work\n");
    await expect(
      removeWorktrees(
        { worktrees: [feature.path], force: false, deleteBranch: false, yes: false },
        context,
      ),
    ).rejects.toThrow("contains staged, unstaged, or untracked changes");
    expect(await fs.readFile(readme, "utf8")).toBe("local work\n");
    expect(prompts.choices).toEqual([]);
  });

  it("returns from batch confirmation to the retained branch selection", async () => {
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    prompts.selections.push("delete", new PromptBackError(), "remove");
    prompts.branches.push(["refs/heads/feature/second"], ["refs/heads/feature/second"]);
    await removeWorktrees(
      { worktrees: [feature.path, second.path], force: false, deleteBranch: false, yes: false },
      context,
    );
    expect(prompts.branchDefaults).toEqual([[], ["refs/heads/feature/second"]]);
    expect(await exists(feature.path)).toBe(false);
    expect(await exists(second.path)).toBe(false);
    expect(
      await context.git.succeeds(["show-ref", "--verify", "refs/heads/feature/topic"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(true);
    expect(
      await context.git.succeeds(["show-ref", "--verify", "refs/heads/feature/second"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(false);
  });

  it("keeps all worktrees and branches when batch confirmation is cancelled", async () => {
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    prompts.selections.push("delete", "cancel");
    prompts.branches.push(["refs/heads/feature/second"]);
    await removeWorktrees(
      { worktrees: [feature.path, second.path], force: false, deleteBranch: false, yes: false },
      context,
    );
    expect(await exists(feature.path)).toBe(true);
    expect(await exists(second.path)).toBe(true);
    expect(
      await context.git.succeeds(["show-ref", "--verify", "refs/heads/feature/second"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(true);
  });

  it("creates from the edited plan after Escape, with only one fetch", async () => {
    const git = vi.spyOn(context.git, "run");
    prompts.searches.push("new:feature/review");
    prompts.selections.push("options", "name", "base", new PromptBackError(), "create");
    prompts.texts.push("review-folder", "main");
    const created = await createWorktree(
      { carry: false, open: false, cd: false, printPath: false },
      context,
    );
    expect(created?.path).toBe(path.join(workspace.worktreeDir, "review-folder"));
    expect(await exists(path.join(workspace.worktreeDir, "feature-review"))).toBe(false);
    expect(git.mock.calls.filter(([args]) => args[0] === "fetch")).toHaveLength(1);
    expect(prompts.choices[0]).toContainEqual(
      expect.objectContaining({ value: "feature/topic", disabled: true }),
    );
  });

  it("renames only the directory when the branch is explicitly kept", async () => {
    prompts.selections.push("directory", "rename");
    prompts.texts.push("review-folder");
    const moved = await renameWorktree({ worktree: feature.path }, context);
    expect(moved?.branch).toBe("feature/topic");
    expect(moved?.path).toBe(path.join(workspace.worktreeDir, "review-folder"));
    expect(await exists(feature.path)).toBe(false);
    expect(
      await context.git.succeeds(["show-ref", "--verify", "refs/heads/review-folder"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(false);
  });

  it("does not mutate the directory or branch when rename is cancelled", async () => {
    prompts.selections.push("both", "cancel");
    prompts.texts.push("review-folder");
    await expect(renameWorktree({ worktree: feature.path }, context)).resolves.toBeNull();
    expect(await exists(feature.path)).toBe(true);
    expect(await exists(path.join(workspace.worktreeDir, "review-folder"))).toBe(false);
    expect(
      await context.git.succeeds(["show-ref", "--verify", "refs/heads/feature/topic"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(true);
  });

  it("offers configuration for an empty task list and permits returning without writes", async () => {
    prompts.selections.push("back");
    await runProjectTask({ worktree: feature.path }, context);
    expect(prompts.choices[0]?.map(({ value }) => value)).toEqual(["configure", "back"]);
    expect(await exists(path.join(workspace.root, ".wald", "project.yml"))).toBe(false);
  });
});

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}
