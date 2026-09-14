import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorktree } from "../src/cli/commands/create.js";
import { handoffWorktree } from "../src/cli/commands/handoff.js";
import { runProjectHook } from "../src/cli/commands/hook.js";
import { openWorktree } from "../src/cli/commands/open.js";
import { removeWorktrees } from "../src/cli/commands/remove.js";
import { renameWorktree } from "../src/cli/commands/rename.js";
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
  promptTextDefaults: [] as Array<string | undefined>,
  searchSelections: [] as Array<string | Error>,
  searchOptions: [] as Array<Array<{ label: string; value: string }>>,
  searchPromptOptions: [] as Array<{ initialValue?: string }>,
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
    promptText: async (_question: string, defaultValue?: string) => {
      prompts.promptTextDefaults.push(defaultValue);
      const result = prompts.promptTexts.shift() ?? "";
      if (result instanceof Error) throw result;
      return result;
    },
    searchSelect: async (
      _question: string,
      options: Array<{ label: string; value: string }>,
      promptOptions: { initialValue?: string } = {},
    ) => {
      prompts.searchOptions.push(options);
      prompts.searchPromptOptions.push(promptOptions);
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
    prompts.promptTextDefaults = [];
    prompts.searchSelections = [];
    prompts.searchOptions = [];
    prompts.searchPromptOptions = [];
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

  it("renames the selected worktree and branch without an extra confirmation", async () => {
    prompts.worktreeSelections.push(feature);
    prompts.promptTexts.push("review");
    const plan = {
      worktree: feature,
      target: review.path,
      branchChange: { before: "feature", after: "review", renamed: true, upstream: null },
    };
    const prepareMove = vi.fn().mockResolvedValue(plan);
    const move = vi.fn().mockResolvedValue(review);
    const context = commandContext(workspace, null, [feature], {
      worktrees: { listMoveCandidates: vi.fn().mockResolvedValue([feature]), prepareMove, move },
    });

    await renameWorktree({}, context);

    expect(prepareMove).toHaveBeenCalledWith(workspace, "feature", "review", undefined, {
      branch: undefined,
      keepBranch: undefined,
    });
    expect(move).toHaveBeenCalledWith(workspace, plan);
    expect(prompts.confirmationQuestions).toEqual([]);
  });

  it("cancels rename input before preparing or mutating the worktree", async () => {
    prompts.worktreeSelections.push(feature);
    prompts.promptTexts.push(new PromptBackError());
    const prepareMove = vi.fn();
    const move = vi.fn();
    const context = commandContext(workspace, null, [feature], {
      worktrees: { listMoveCandidates: vi.fn().mockResolvedValue([feature]), prepareMove, move },
    });
    await expect(renameWorktree({}, context)).rejects.toBeInstanceOf(PromptBackError);
    expect(prepareMove).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("confirms an interactively selected create plan with Yes by default", async () => {
    prompts.searchSelections.push("feature");
    prompts.confirmations.push(true);
    const executeCreate = vi.fn().mockResolvedValue(feature);
    const context = createContextForCreate(workspace, feature, executeCreate);

    await createWorktree({ carry: false, cd: false, open: false, printPath: false }, context);

    expect(prompts.confirmationQuestions).toContain("Create this worktree?");
    expect(prompts.confirmationDefaults).toContain(true);
    expect(executeCreate).toHaveBeenCalledOnce();
  });

  it("cancels an interactive create before trust or mutation", async () => {
    prompts.searchSelections.push("feature");
    prompts.confirmations.push(false);
    const executeCreate = vi.fn();
    const context = createContextForCreate(workspace, feature, executeCreate);

    await expect(
      createWorktree({ carry: false, cd: false, open: false, printPath: false }, context),
    ).resolves.toBeNull();

    expect(executeCreate).not.toHaveBeenCalled();
    expect(context.configs.isTrusted).not.toHaveBeenCalled();
  });

  it("states that only remote refs changed when a fetched plan is declined", async () => {
    prompts.searchSelections.push("feature");
    prompts.confirmations.push(false);
    let stdout = "";
    const context = createContextForCreate(workspace, feature, vi.fn(), null, "origin");
    context.output.stdout = {
      write: (value: string) => {
        stdout += value;
        return true;
      },
    } as NodeJS.WritableStream;

    await createWorktree({ carry: false, cd: false, open: false, printPath: false }, context);

    expect(stdout).toContain("Only remote refs from origin were updated during preparation");
    expect(context.workflow.executeCreate).not.toHaveBeenCalled();
  });

  it("returns from create confirmation with the previous branch selection retained", async () => {
    prompts.searchSelections.push("feature", "feature");
    prompts.confirmations.push(new PromptBackError(), true);
    const executeCreate = vi.fn().mockResolvedValue(feature);
    const context = createContextForCreate(workspace, feature, executeCreate);

    await createWorktree({ carry: false, cd: false, open: false, printPath: false }, context);

    expect(prompts.searchPromptOptions[1]).toMatchObject({ initialValue: "feature" });
    expect(executeCreate).toHaveBeenCalledOnce();
  });

  it("does not confirm a fully explicit create command", async () => {
    const executeCreate = vi.fn().mockResolvedValue(feature);
    const context = createContextForCreate(workspace, feature, executeCreate);

    await createWorktree(
      { branch: "feature", carry: false, cd: false, open: false, printPath: false },
      context,
    );

    expect(prompts.confirmationQuestions).toEqual([]);
    expect(executeCreate).toHaveBeenCalledOnce();
  });

  it("confirms an interactively entered handoff branch before carrying changes", async () => {
    prompts.promptTexts.push("review");
    prompts.confirmations.push(true);
    const executeCreate = vi.fn().mockResolvedValue(review);
    const context = createContextForCreate(workspace, review, executeCreate, primary);

    await handoffWorktree({ cd: false, open: false, printPath: false }, context);

    expect(prompts.confirmationQuestions).toContain("Create this worktree?");
    expect(executeCreate).toHaveBeenCalledOnce();
  });

  it("returns from handoff confirmation with the previous branch text retained", async () => {
    prompts.promptTexts.push("review", "review");
    prompts.confirmations.push(new PromptBackError(), true);
    const executeCreate = vi.fn().mockResolvedValue(review);
    const context = createContextForCreate(workspace, review, executeCreate, primary);

    await handoffWorktree({ cd: false, open: false, printPath: false }, context);

    expect(prompts.promptTextDefaults).toEqual([undefined, "review"]);
    expect(executeCreate).toHaveBeenCalledOnce();
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
          eligible: true,
          branch: feature.branch,
          branchRef: "refs/heads/feature",
          expectedHead: "abc123",
          mergedIntoDefault: false,
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

  it("uses the eligible branch decision as the final removal confirmation", async () => {
    prompts.confirmations.push(true);
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
              mergedIntoDefault: true,
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

    expect(prompts.confirmationQuestions[0]).toContain("Delete local branch feature too?");
    expect(prompts.confirmationDefaults[0]).toBe(false);
    expect(prompts.confirmationQuestions).toHaveLength(1);
    expect(executeRemove).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ deleteBranch: true }),
    );
  });

  it("offers an unmerged branch for deletion when removal is forced", async () => {
    prompts.confirmations.push(true);
    const executeRemove = vi.fn();
    const context = commandContext(workspace, primary, [primary, feature], {
      workflow: {
        planRemove: vi.fn().mockResolvedValue({
          inspection: {
            worktree: feature,
            hardBlockers: [],
            blockers: ["the branch is not merged into main"],
            branchDeletion: {
              eligible: true,
              branch: feature.branch,
              branchRef: "refs/heads/feature",
              expectedHead: "abc123",
              mergedIntoDefault: false,
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
        force: true,
        deleteBranch: false,
        yes: false,
      },
      context,
    );

    expect(prompts.confirmationQuestions[0]).toContain("Delete unmerged local branch feature too?");
    expect(prompts.confirmationDefaults[0]).toBe(false);
    expect(executeRemove).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ deleteBranch: true, force: true }),
    );
  });

  it("offers multiple eligible branches as an unselected checkbox list", async () => {
    prompts.manyValueSelections.push(["refs/heads/review"]);
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
                mergedIntoDefault: true,
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
    expect(prompts.confirmationQuestions).toEqual([]);
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

function createContextForCreate(
  workspace: Workspace,
  created: Worktree,
  executeCreate: ReturnType<typeof vi.fn>,
  carrySource: Worktree | null = null,
  fetchedRemote: string | null = null,
): CliContext {
  const completeWorkspace = {
    ...workspace,
    config: { defaultBranch: "main", remote: null },
  } as Workspace;
  const plan = {
    workspace: completeWorkspace,
    prepared: {
      branch: created.branch,
      branchRef: `refs/heads/${created.branch}`,
      target: created.path,
      projectRevision: `refs/heads/${created.branch}`,
      strategy: { type: "local" },
    },
    project: null,
    trusted: true,
    carrySource,
    fetchedRemote,
    current: carrySource,
    defaultWorktree: null,
    primary: carrySource,
  };
  return commandContext(completeWorkspace, carrySource, carrySource ? [carrySource] : [], {
    worktrees: {
      current: vi.fn().mockResolvedValue(carrySource),
      list: vi.fn().mockResolvedValue(carrySource ? [carrySource] : []),
      listBranchCandidates: vi
        .fn()
        .mockResolvedValue([{ name: created.branch, label: created.branch, source: "local" }]),
    },
    configs: { isTrusted: vi.fn().mockReturnValue(true) },
    workflow: {
      planCreate: vi.fn().mockResolvedValue(plan),
      executeCreate,
    },
  });
}
