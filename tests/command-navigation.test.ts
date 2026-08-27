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
  manySelections: [] as Worktree[][],
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
    confirm: async () => {
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
  };
});

describe("interactive command navigation", () => {
  const workspace = { root: "/workspace" } as Workspace;
  const primary = worktree("main", "/workspace/main", "primary");
  const feature = worktree("feature", "/workspace/feature");
  const review = worktree("review", "/workspace/review");

  beforeEach(() => {
    prompts.confirmations = [];
    prompts.manySelections = [];
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
          },
          project: null,
        })),
        executeRemove,
      },
    });

    await removeWorktrees({ worktrees: [], force: false, yes: false }, context);

    expect(prompts.manyOptions[1]).toEqual({ initialValues: [feature.path], navigation: "cancel" });
    expect(executeRemove).toHaveBeenCalledWith(
      expect.objectContaining({ inspection: expect.objectContaining({ worktree: review }) }),
      expect.any(Object),
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
