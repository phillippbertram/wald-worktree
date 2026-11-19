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
import { createProgram } from "../src/cli/create-program.js";
import { runMainMenu } from "../src/cli/main-menu.js";
import type { Workspace, Worktree } from "../src/domain/types.js";
import { PromptBackError, PromptExitError } from "../src/ui/terminal.js";
import { createTestRepository } from "./helpers/git-repository.js";

const prompts = vi.hoisted(() => ({
  selections: [] as Array<string | Error>,
  searches: [] as string[],
  texts: [] as string[],
  branches: [] as string[][],
  branchDefaults: [] as string[][],
  choices: [] as Array<Array<{ value: string; label: string; disabled?: boolean }>>,
  initialValues: [] as Array<string | undefined>,
  worktrees: [] as string[][],
  worktreeDefaults: [] as string[][],
  offeredWorktrees: [] as Worktree[][],
  interactive: true,
  trustRequests: 0,
}));

vi.mock("../src/ui/terminal.js", async (original) => ({
  ...(await original<typeof import("../src/ui/terminal.js")>()),
  isInteractiveTerminal: () => prompts.interactive,
  runTask: async <T>(_label: string, task: () => Promise<T>) => task(),
  printStatus: async () => undefined,
  confirm: async () => {
    prompts.trustRequests += 1;
    return false;
  },
  selectValue: async (
    _question: string,
    choices: Array<{ value: string; label: string; disabled?: boolean }>,
    options: { initialValue?: string },
  ) => {
    prompts.choices.push(choices);
    prompts.initialValues.push(options.initialValue);
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
  selectManyWorktrees: async (
    _question: string,
    worktrees: Worktree[],
    options: { initialValues?: string[] },
  ) => {
    prompts.offeredWorktrees.push(worktrees);
    prompts.worktreeDefaults.push([...(options.initialValues ?? [])]);
    const paths = prompts.worktrees.shift() ?? [];
    return worktrees.filter((worktree) => paths.includes(worktree.path));
  },
}));

describe("guided UX with real worktrees", () => {
  let root: string;
  let context: ReturnType<typeof createCliContext>;
  let workspace: Workspace;
  let feature: Worktree;
  let output: PassThrough;

  beforeEach(async () => {
    prompts.selections = [];
    prompts.searches = [];
    prompts.texts = [];
    prompts.branches = [];
    prompts.branchDefaults = [];
    prompts.choices = [];
    prompts.initialValues = [];
    prompts.worktrees = [];
    prompts.worktreeDefaults = [];
    prompts.offeredWorktrees = [];
    prompts.interactive = true;
    prompts.trustRequests = 0;
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wald-guided-ux-")));
    const repository = await createTestRepository(root);
    output = new PassThrough();
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

  async function prepareRisk(risk: "dirty" | "unmerged" | "locked"): Promise<void> {
    if (risk === "locked") {
      await context.git.run(["worktree", "lock", "--reason", "unfinished work", feature.path], {
        gitDir: workspace.gitDir,
      });
      return;
    }
    await fs.writeFile(path.join(feature.path, "README.md"), "local work\n");
    if (risk === "unmerged") {
      await context.git.run(["config", "user.email", "tests@example.invalid"], {
        cwd: feature.path,
      });
      await context.git.run(["config", "user.name", "wald tests"], { cwd: feature.path });
      await context.git.run(["add", "README.md"], { cwd: feature.path });
      await context.git.run(["commit", "-m", "unmerged work"], { cwd: feature.path });
    }
  }

  async function branchExists(branch = "feature/topic"): Promise<boolean> {
    return await context.git.succeeds(["show-ref", "--verify", `refs/heads/${branch}`], {
      gitDir: workspace.gitDir,
    });
  }

  it.each(["dirty", "unmerged", "locked"] as const)(
    "removes a %s worktree only after explicit force consent, keeping its branch",
    async (risk) => {
      await prepareRisk(risk);
      const execute = vi.spyOn(context.workflow, "executeRemove");
      prompts.selections.push("keep");
      await removeWorktrees(
        { worktrees: [feature.path], force: false, deleteBranch: false, yes: false },
        context,
      );
      expect(await exists(feature.path)).toBe(false);
      expect(await branchExists()).toBe(true);
      expect(execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ force: true, deleteBranch: false }),
      );
      expect(prompts.choices[0]).toContainEqual(
        expect.objectContaining({ value: "keep", label: expect.stringContaining("Force removal") }),
      );
      expect(prompts.initialValues).toEqual(["cancel"]);
      const rendered = output.read()?.toString() ?? "";
      expect(rendered).toContain(feature.path);
      expect(rendered).toContain(
        risk === "dirty"
          ? "contains staged, unstaged, or untracked changes"
          : risk === "unmerged"
            ? "the branch is not merged into main"
            : "the worktree is locked",
      );
    },
  );

  it.each(["dirty", "unmerged", "locked"] as const)(
    "preserves a %s worktree and skips trust and hooks when force is declined",
    async (risk) => {
      await prepareRisk(risk);
      await fs.writeFile(
        path.join(workspace.root, ".wald", "project.yml"),
        "version: 1\nhooks:\n  pre_remove:\n    - type: command\n      argv: [node, -e, 'process.exit(7)']\n",
      );
      const trust = vi.spyOn(context.configs, "trust");
      const execute = vi.spyOn(context.workflow, "executeRemove");
      prompts.selections.push("cancel");
      await removeWorktrees(
        { worktrees: [feature.path], force: false, deleteBranch: false, yes: false },
        context,
      );
      expect(await exists(feature.path)).toBe(true);
      expect(await branchExists()).toBe(true);
      expect(await fs.readFile(path.join(feature.path, "README.md"), "utf8")).toBe(
        risk === "locked" ? "# fixture\n" : "local work\n",
      );
      expect((await context.worktrees.resolve(workspace, feature.path)).locked).toBe(
        risk === "locked",
      );
      expect(trust).not.toHaveBeenCalled();
      expect(prompts.trustRequests).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("cancels a preselected branch deletion without granting force", async () => {
    await prepareRisk("dirty");
    prompts.selections.push("cancel");
    await removeWorktrees(
      { worktrees: [feature.path], force: false, deleteBranch: true, yes: false },
      context,
    );
    expect(await fs.readFile(path.join(feature.path, "README.md"), "utf8")).toBe("local work\n");
    expect(await branchExists()).toBe(true);
  });

  it("preserves dirty files, branches and locks when force confirmation is interrupted", async () => {
    await prepareRisk("dirty");
    await prepareRisk("locked");
    prompts.selections.push(new PromptExitError());
    await expect(
      removeWorktrees(
        { worktrees: [feature.path], force: false, deleteBranch: false, yes: false },
        context,
      ),
    ).rejects.toMatchObject({ exitCode: 130 });
    expect(await fs.readFile(path.join(feature.path, "README.md"), "utf8")).toBe("local work\n");
    expect(await branchExists()).toBe(true);
    expect((await context.worktrees.resolve(workspace, feature.path)).locked).toBe(true);
  });

  it.each([
    { interactive: true, yes: true, json: false },
    { interactive: true, yes: true, json: true },
    { interactive: false, yes: false, json: false },
    { interactive: false, yes: true, json: false },
  ])("requires explicit --force without prompts: %j", async ({ interactive, yes, json }) => {
    await prepareRisk("dirty");
    prompts.interactive = interactive;
    await expect(
      removeWorktrees(
        { worktrees: [feature.path], force: false, deleteBranch: false, yes, json },
        context,
      ),
    ).rejects.toThrow("use --force only if this data can be discarded");
    expect(await fs.readFile(path.join(feature.path, "README.md"), "utf8")).toBe("local work\n");
    expect(await branchExists()).toBe(true);
    expect(prompts.choices).toEqual([]);
  });

  it("returns from batch confirmation to the retained branch selection", async () => {
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    prompts.selections.push("choose", new PromptBackError(), "remove");
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
    prompts.selections.push("choose", "cancel");
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

  it("removes a mixed batch and all eligible branches after one force confirmation", async () => {
    await prepareRisk("unmerged");
    await fs.writeFile(path.join(feature.path, "untracked.txt"), "local work\n");
    await prepareRisk("locked");
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    const main = await context.worktrees.add(workspace, { branch: "main", fetch: false });
    const detached = await context.worktrees.add(workspace, {
      branch: "feature/detached",
      fetch: false,
    });
    await context.git.run(["checkout", "--detach"], { cwd: detached.path });
    const execute = vi.spyOn(context.workflow, "executeRemove");
    prompts.selections.push("delete", "force");
    await removeWorktrees(
      {
        worktrees: [feature.path, second.path, main.path, detached.path, feature.name],
        force: false,
        deleteBranch: false,
        yes: false,
      },
      context,
    );
    for (const worktree of [feature, second, main, detached]) {
      expect(await exists(worktree.path)).toBe(false);
    }
    expect(await branchExists()).toBe(false);
    expect(await branchExists("feature/second")).toBe(false);
    expect(await branchExists("main")).toBe(true);
    expect(await branchExists("feature/detached")).toBe(true);
    expect(prompts.branchDefaults).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls.map(([, options]) => options?.force)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("Delete local branch: feature/topic");
    expect(rendered).toContain("Delete local branch: feature/second");
    expect(rendered).toContain(
      "Keep local branch: main (the configured default branch is never deleted)",
    );
    expect(rendered).toContain("No local branch deleted:");
    expect(rendered).toContain("the worktree contains staged, unstaged, or untracked changes");
    expect(rendered).toContain("the branch is not merged into main");
    expect(rendered).toContain("the worktree is locked");
    expect(prompts.initialValues).toEqual(["cancel", "cancel"]);
  });

  it("keeps every branch when removing multiple worktrees without branch deletion", async () => {
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    prompts.selections.push("keep", "remove");
    await removeWorktrees(
      { worktrees: [feature.path, second.path], force: false, deleteBranch: false, yes: false },
      context,
    );
    expect(await exists(feature.path)).toBe(false);
    expect(await exists(second.path)).toBe(false);
    expect(await branchExists()).toBe(true);
    expect(await branchExists("feature/second")).toBe(true);
  });

  it("deletes an unmerged branch with --delete-branch after interactive force consent", async () => {
    await prepareRisk("unmerged");
    prompts.selections.push("force");
    await removeWorktrees(
      { worktrees: [feature.path], force: false, deleteBranch: true, yes: false },
      context,
    );
    expect(await exists(feature.path)).toBe(false);
    expect(await branchExists()).toBe(false);
  });

  it("retains branch selection after going back from force confirmation", async () => {
    await prepareRisk("unmerged");
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    prompts.selections.push("choose", new PromptBackError(), "force");
    prompts.branches.push(["refs/heads/feature/topic"], ["refs/heads/feature/topic"]);
    await removeWorktrees(
      { worktrees: [feature.path, second.path], force: false, deleteBranch: false, yes: false },
      context,
    );
    expect(prompts.branchDefaults).toEqual([[], ["refs/heads/feature/topic"]]);
    expect(await exists(feature.path)).toBe(false);
    expect(await exists(second.path)).toBe(false);
    expect(await branchExists()).toBe(false);
    expect(await branchExists("feature/second")).toBe(true);
  });

  it("reviews force again after returning to a changed worktree selection", async () => {
    await prepareRisk("dirty");
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    await fs.writeFile(path.join(second.path, "README.md"), "other local work\n");
    prompts.worktrees.push([feature.path], [second.path]);
    prompts.selections.push(new PromptBackError(), "cancel");
    await removeWorktrees(
      { worktrees: [], force: false, deleteBranch: false, yes: false },
      context,
    );
    expect(prompts.worktreeDefaults).toEqual([[], [feature.path]]);
    expect(
      prompts.choices.filter((choices) =>
        choices.some(({ label }) => label.includes("Force removal")),
      ),
    ).toHaveLength(2);
    expect(await fs.readFile(path.join(feature.path, "README.md"), "utf8")).toBe("local work\n");
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe(
      "other local work\n",
    );
    expect(await branchExists()).toBe(true);
    expect(await branchExists("feature/second")).toBe(true);
  });

  it("removes multiple worktrees and branches through the main menu, excluding the current checkout", async () => {
    const main = await context.worktrees.add(workspace, { branch: "main", fetch: false });
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    vi.spyOn(context.worktrees, "current").mockResolvedValue(main);
    prompts.worktrees.push([feature.path, second.path]);
    prompts.selections.push("remove", "delete", "remove", "exit");
    await runMainMenu(createProgram(), context);
    expect(prompts.offeredWorktrees[0]?.map((worktree) => worktree.path)).toEqual(
      expect.arrayContaining([feature.path, second.path]),
    );
    expect(prompts.offeredWorktrees[0]?.some((worktree) => worktree.path === main.path)).toBe(
      false,
    );
    expect(await exists(main.path)).toBe(true);
    expect(await exists(feature.path)).toBe(false);
    expect(await exists(second.path)).toBe(false);
    expect(await branchExists()).toBe(false);
    expect(await branchExists("feature/second")).toBe(false);
    expect(await branchExists("main")).toBe(true);
  });

  it("rejects hard blockers before offering force or removing any batch member", async () => {
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    const plan = await context.workflow.planRemove(workspace, second.path);
    plan.inspection.hardBlockers.push("the worktree state could not be read safely");
    const planRemove = context.workflow.planRemove.bind(context.workflow);
    vi.spyOn(context.workflow, "planRemove").mockImplementation(async (workspace, identifier) =>
      identifier === second.path ? plan : await planRemove(workspace, identifier),
    );
    await expect(
      removeWorktrees(
        { worktrees: [feature.path, second.path], force: true, deleteBranch: false, yes: false },
        context,
      ),
    ).rejects.toThrow("the worktree state could not be read safely");
    expect(prompts.choices).toEqual([]);
    expect(await exists(feature.path)).toBe(true);
    expect(await exists(second.path)).toBe(true);
    expect(await branchExists()).toBe(true);
    expect(await branchExists("feature/second")).toBe(true);
  });

  it("preserves worktrees and branches when trust is declined after force consent", async () => {
    await prepareRisk("dirty");
    await fs.writeFile(
      path.join(workspace.root, ".wald", "project.yml"),
      "version: 1\nhooks:\n  pre_remove:\n    - type: command\n      argv: [node, -e, 'process.exit(7)']\n",
    );
    prompts.selections.push("delete");
    await expect(
      removeWorktrees(
        { worktrees: [feature.path], force: false, deleteBranch: false, yes: false },
        context,
      ),
    ).rejects.toThrow("Project configuration was not trusted");
    expect(prompts.trustRequests).toBe(1);
    expect(prompts.selections).toEqual([]);
    expect(await fs.readFile(path.join(feature.path, "README.md"), "utf8")).toBe("local work\n");
    expect(await branchExists()).toBe(true);
  });

  it("stops a forced batch after a post-remove hook fails and preserves remaining branches and worktrees", async () => {
    await prepareRisk("unmerged");
    const main = await context.worktrees.add(workspace, { branch: "main", fetch: false });
    const second = await context.worktrees.add(workspace, {
      branch: "feature/second",
      fetch: false,
    });
    await fs.writeFile(
      path.join(workspace.root, ".wald", "project.yml"),
      "version: 1\nhooks:\n  post_remove:\n    - type: command\n      argv: [node, -e, 'process.exit(7)']\n",
    );
    const project = await context.configs.resolveProjectConfig(workspace, feature.path);
    if (!project) throw new Error("Missing hook configuration");
    await context.configs.trust(workspace, project);
    prompts.selections.push("delete", "force");
    await expect(
      removeWorktrees(
        { worktrees: [feature.path, second.path], force: false, deleteBranch: false, yes: false },
        context,
      ),
    ).rejects.toThrow("was removed, but its post-remove hook failed");
    expect(await exists(feature.path)).toBe(false);
    expect(await exists(second.path)).toBe(true);
    expect(await exists(main.path)).toBe(true);
    expect(await branchExists()).toBe(true);
    expect(await branchExists("feature/second")).toBe(true);
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
