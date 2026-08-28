import { beforeEach, describe, expect, it, vi } from "vitest";
import { runProjectHook } from "../src/cli/commands/hook.js";
import { openWorktree } from "../src/cli/commands/open.js";
import { removeWorktrees } from "../src/cli/commands/remove.js";
import { runProjectTask } from "../src/cli/commands/run.js";
import type { CliContext } from "../src/cli/context.js";
import { chooseBranch } from "../src/cli/helpers.js";
import type { Workspace, Worktree } from "../src/domain/types.js";
import { PromptBackError } from "../src/ui/terminal.js";

const prompts = vi.hoisted(() => ({
  confirmations: [] as Array<boolean | Error>,
  confirmationDefaults: [] as boolean[],
  confirmationQuestions: [] as string[],
  manySelections: [] as Worktree[][],
  manyValueSelections: [] as string[][],
  manyValueOptions: [] as Array<{ initialValues?: string[] }>,
  promptTexts: [] as Array<string | Error>,
  searchSelections: [] as Array<string | Error>,
  searchOptions: [] as Array<Array<{ label: string; value: string }>>,
  worktreeSelections: [] as Array<Worktree | Error>,
  manyOptions: [] as Array<{ initialValues?: string[] }>,
}));

vi.mock("../src/ui/terminal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/terminal.js")>();
  return {
    ...actual,
    isInteractiveTerminal: () => true,
    printStatus: async () => undefined,
    runTask: async <T>(_label: string, task: () => Promise<T>) => await task(),
    confirm: async (question: string, defaultValue: boolean) => {
      prompts.confirmationQuestions.push(question);
      prompts.confirmationDefaults.push(defaultValue);
      const result = prompts.confirmations.shift() ?? false;
      if (result instanceof Error) throw result;
      return result;
    },
    promptText: async () => {
      const result = prompts.promptTexts.shift() ?? "";
      if (result instanceof Error) throw result;
      return result;
    },
    searchSelect: async (_question: string, options: Array<{ label: string; value: string }>) => {
      prompts.searchOptions.push(options);
      const result = prompts.searchSelections.shift() ?? "";
      if (result instanceof Error) throw result;
      return result;
    },
    selectWorktree: async () => {
      const result = prompts.worktreeSelections.shift() ?? null;
      if (result instanceof Error) throw result;
      return result;
    },
    selectManyWorktrees: async (
      _question: string,
      _worktrees: Worktree[],
      options: { initialValues?: string[] },
    ) => {
      prompts.manyOptions.push(options);
      return prompts.manySelections.shift() ?? [];
    },
    selectManyValues: async (
      _question: string,
      _choices: Array<{ label: string; value: string }>,
      options: { initialValues?: string[] },
    ) => {
      prompts.manyValueOptions.push(options);
      return prompts.manyValueSelections.shift() ?? [];
    },
  };
});

describe("interactive command navigation", () => {
  const workspace = { root: "/workspace" } as Workspace;
  const primary = worktree("main", "/workspace/main", "primary");
  const feature = worktree("feature", "/workspace/feature");
  const review = worktree("review", "/workspace/review");

  beforeEach(() => {
    prompts.confirmations = [];
    prompts.confirmationDefaults = [];
    prompts.confirmationQuestions = [];
    prompts.manySelections = [];
    prompts.manyValueSelections = [];
    prompts.manyValueOptions = [];
    prompts.promptTexts = [];
    prompts.searchSelections = [];
    prompts.searchOptions = [];
    prompts.worktreeSelections = [];
    prompts.manyOptions = [];
  });

  it("returns from a new branch name to the branch selection", async () => {
    prompts.searchSelections.push("__create_new_branch__", "existing");
    prompts.promptTexts.push(new PromptBackError());
    const worktrees = {
      listBranchCandidates: vi
        .fn()
        .mockResolvedValue([{ name: "existing", label: "existing", source: "local" }]),
    };

    await expect(
      chooseBranch(workspace, worktrees as unknown as CliContext["worktrees"]),
    ).resolves.toBe("existing");
  });

  it("returns from tool selection to worktree selection", async () => {
    prompts.searchSelections.push(new PromptBackError(), "code");
    prompts.worktreeSelections.push(feature);
    const open = vi.fn();
    const context = commandContext(workspace, primary, [primary, feature], {
      tools: {
        availableProfiles: vi
          .fn()
          .mockResolvedValue([{ name: "code", profile: { description: "Visual Studio Code" } }]),
        open,
      },
      workflow: { projectForWorktree: vi.fn().mockResolvedValue(null) },
    });

    await openWorktree(undefined, undefined, context);

    expect(open).toHaveBeenCalledWith(feature, "code", null);
  });

  it("returns from task selection to worktree selection", async () => {
    prompts.searchSelections.push(new PromptBackError(), "verify");
    prompts.worktreeSelections.push(feature);
    const runTask = vi.fn();
    const project = {
      config: { tasks: { verify: { description: "Check the project", steps: [] } } },
    };
    const context = commandContext(workspace, primary, [primary, feature], {
      configs: { isTrusted: vi.fn().mockReturnValue(true) },
      workflow: {
        projectForWorktree: vi.fn().mockResolvedValue(project),
        runTask,
      },
    });

    await runProjectTask({}, context);

    expect(runTask).toHaveBeenCalledWith(
      workspace,
      feature,
      "verify",
      expect.objectContaining({ output: context.output.stderr }),
    );
  });

  it("offers only configured hooks for the selected worktree", async () => {
    prompts.searchSelections.push("pre_remove");
    const runHook = vi.fn();
    const project = {
      config: {
        hooks: {
          pre_create: [],
          post_create: [],
          pre_remove: [{ type: "command" }],
          post_remove: [],
        },
      },
    };
    const context = commandContext(workspace, primary, [primary, feature], {
      configs: { isTrusted: vi.fn().mockReturnValue(true) },
      workflow: {
        projectForWorktree: vi.fn().mockResolvedValue(project),
        runHook,
      },
    });

    await runProjectHook({}, context);

    expect(prompts.searchOptions.at(-1)?.map((option) => option.value)).toEqual(["pre_remove"]);
    expect(runHook).toHaveBeenCalledWith(
      workspace,
      primary,
      "pre_remove",
      expect.objectContaining({ output: context.output.stderr }),
    );
  });

  it("returns from removal confirmation and preserves the checkbox selection", async () => {
    prompts.manySelections.push([feature], [review]);
    prompts.confirmations.push(new PromptBackError(), true);
    const executeRemove = vi.fn();
    const context = commandContext(workspace, primary, [primary, feature, review], {
      workflow: {
        planRemove: vi.fn(async (_workspace: Workspace, name: string) => ({
          inspection: {
            worktree: name === feature.name ? feature : review,
            hardBlockers: [],
            blockers: [],
            branchDeletion: {
              eligible: false,
              branch: name,
              reason: "not eligible in this test",
            },
          },
          project: null,
        })),
        executeRemove,
      },
    });

    await removeWorktrees(
      { worktrees: [], force: false, deleteBranch: false, yes: false },
      context,
    );

    expect(prompts.manyOptions[1]).toEqual({ initialValues: [feature.path], navigation: "cancel" });
    expect(executeRemove).toHaveBeenCalledWith(
      expect.objectContaining({ inspection: expect.objectContaining({ worktree: review }) }),
      expect.any(Object),
    );
  });

  it("deduplicates forced removals and prints every bypassed safeguard", async () => {
    let stderr = "";
    const executeRemove = vi.fn();
    const plan = {
      workspace,
      inspection: {
        worktree: feature,
        hardBlockers: [],
        blockers: [
          "the worktree contains staged, unstaged, or untracked changes",
          "the branch is not merged into main",
        ],
        branchDeletion: {
          eligible: false,
          branch: feature.branch,
          reason: "the branch is not merged into main",
        },
      },
      project: null,
    };
    const context = commandContext(workspace, primary, [primary, feature], {
      output: {
        stdout: { write: () => true },
        stderr: {
          write: (value: string) => {
            stderr += value;
            return true;
          },
        },
      },
      workflow: { planRemove: vi.fn().mockResolvedValue(plan), executeRemove },
    });

    await removeWorktrees(
      {
        worktrees: [feature.name, feature.path],
        force: true,
        deleteBranch: false,
        yes: true,
      },
      context,
    );

    expect(executeRemove).toHaveBeenCalledOnce();
    expect(stderr).toContain("--force bypasses these removal safeguards");
    expect(stderr).toContain(feature.path);
    expect(stderr).toContain("staged, unstaged, or untracked changes");
    expect(stderr).toContain("not merged into main");
  });

  it("offers eligible local branch deletion with a safe default before confirmation", async () => {
    prompts.confirmations.push(true, true);
    const executeRemove = vi.fn();
    const context = commandContext(workspace, primary, [primary, feature], {
      workflow: {
        planRemove: vi.fn().mockResolvedValue({
          inspection: {
            worktree: feature,
            hardBlockers: [],
            blockers: [],
            branchDeletion: {
              eligible: true,
              branch: feature.branch,
              branchRef: "refs/heads/feature",
              expectedHead: "abc123",
            },
          },
          project: null,
        }),
        executeRemove,
      },
    });

    await removeWorktrees(
      {
        worktrees: [feature.name],
        force: false,
        deleteBranch: false,
        yes: false,
      },
      context,
    );

    expect(prompts.confirmationQuestions[0]).toContain("Delete merged local branch feature too?");
    expect(prompts.confirmationDefaults[0]).toBe(false);
    expect(prompts.confirmationQuestions[1]).toContain("Delete local branch: feature.");
    expect(executeRemove).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ deleteBranch: true }),
    );
  });

  it("offers multiple eligible branches as an unselected checkbox list", async () => {
    prompts.manyValueSelections.push(["refs/heads/review"]);
    prompts.confirmations.push(true);
    const executeRemove = vi.fn();
    const context = commandContext(workspace, primary, [primary, feature, review], {
      workflow: {
        planRemove: vi.fn(async (_workspace: Workspace, name: string) => {
          const worktree = name === feature.name ? feature : review;
          return {
            inspection: {
              worktree,
              hardBlockers: [],
              blockers: [],
              branchDeletion: {
                eligible: true,
                branch: worktree.branch,
                branchRef: `refs/heads/${worktree.branch}`,
                expectedHead: "abc123",
              },
            },
            project: null,
          };
        }),
        executeRemove,
      },
    });

    await removeWorktrees(
      {
        worktrees: [feature.name, review.name],
        force: false,
        deleteBranch: false,
        yes: false,
      },
      context,
    );

    expect(prompts.manyValueOptions).toEqual([{ initialValues: [], navigation: "cancel" }]);
    expect(executeRemove).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      expect.objectContaining({ deleteBranch: false }),
    );
    expect(executeRemove).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ deleteBranch: true }),
    );
  });
});

function worktree(name: string, path: string, role = "linked"): Worktree {
  return {
    name,
    path,
    branch: name,
    role,
    state: "clean",
  } as Worktree;
}

function commandContext(
  workspace: Workspace,
  current: Worktree | null,
  worktrees: Worktree[],
  overrides: Record<string, unknown>,
): CliContext {
  const stream = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    output: { stdout: stream, stderr: stream },
    workspaces: { find: vi.fn().mockResolvedValue(workspace) },
    worktrees: {
      current: vi.fn().mockResolvedValue(current),
      list: vi.fn().mockResolvedValue(worktrees),
    },
    configs: { isTrusted: vi.fn().mockReturnValue(true) },
    ...overrides,
  } as unknown as CliContext;
}
