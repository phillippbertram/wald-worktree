import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../src/cli/context.js";
import { runMainMenu } from "../src/cli/main-menu.js";
import { WaldError } from "../src/domain/errors.js";
import type { Workspace, Worktree } from "../src/domain/types.js";
import { PromptBackError } from "../src/ui/terminal.js";

const interactions = vi.hoisted(() => ({
  interactive: true,
  selections: [] as Array<string | Error>,
  selectCalls: [] as Array<{
    options: Array<{ label: string; description?: string; group?: string }>;
    navigation?: string;
  }>,
  events: [] as string[],
  findWorkspaceOrNull: vi.fn(),
  initializeWorkspace: vi.fn(),
  createWorktree: vi.fn(),
  handoffWorktree: vi.fn(),
  listWorktrees: vi.fn(),
  renameWorktree: vi.fn(),
  runProjectHook: vi.fn(),
  uninitializeWorkspace: vi.fn(),
}));

vi.mock("../src/ui/terminal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/terminal.js")>();
  return {
    ...actual,
    isInteractiveTerminal: () => interactions.interactive,
    selectValue: async (
      _question: string,
      options: Array<{ label: string; description?: string; group?: string }>,
      promptOptions?: { navigation?: string },
    ) => {
      interactions.events.push("prompt");
      interactions.selectCalls.push({ options, navigation: promptOptions?.navigation });
      const selection = interactions.selections.shift() ?? "exit";
      if (selection instanceof Error) throw selection;
      return selection;
    },
  };
});

vi.mock("../src/cli/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/helpers.js")>();
  return {
    ...actual,
    findWorkspaceOrNull: interactions.findWorkspaceOrNull,
  };
});

vi.mock("../src/cli/commands/init.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/commands/init.js")>();
  return {
    ...actual,
    initializeWorkspace: interactions.initializeWorkspace,
  };
});

vi.mock("../src/cli/commands/create.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/commands/create.js")>();
  return {
    ...actual,
    createWorktree: interactions.createWorktree,
  };
});

vi.mock("../src/cli/commands/handoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/commands/handoff.js")>();
  return {
    ...actual,
    handoffWorktree: interactions.handoffWorktree,
  };
});

vi.mock("../src/cli/commands/list.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/commands/list.js")>();
  return {
    ...actual,
    listWorktrees: interactions.listWorktrees,
  };
});

vi.mock("../src/cli/commands/rename.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/commands/rename.js")>();
  return {
    ...actual,
    renameWorktree: interactions.renameWorktree,
  };
});

vi.mock("../src/cli/commands/hook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/commands/hook.js")>();
  return {
    ...actual,
    runProjectHook: interactions.runProjectHook,
  };
});

vi.mock("../src/cli/commands/uninit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/commands/uninit.js")>();
  return {
    ...actual,
    uninitializeWorkspace: interactions.uninitializeWorkspace,
  };
});

describe("interactive main menu", () => {
  beforeEach(() => {
    interactions.interactive = true;
    interactions.selections = ["exit"];
    interactions.selectCalls = [];
    interactions.events = [];
    interactions.findWorkspaceOrNull.mockReset();
    interactions.initializeWorkspace.mockReset();
    interactions.initializeWorkspace.mockImplementation(async () => {
      interactions.events.push("init");
    });
    interactions.createWorktree.mockReset();
    interactions.handoffWorktree.mockReset();
    interactions.listWorktrees.mockReset();
    interactions.renameWorktree.mockReset();
    interactions.runProjectHook.mockReset();
    interactions.uninitializeWorkspace.mockReset();
  });

  it("shows workspace context before prompting", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    const current = {
      name: "main",
      branch: "main",
    } as Worktree;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    const context = createContext(current, [current]);

    await runMainMenu(new Command().name("wald"), context);

    expect(interactions.events[0]).toContain("Where Git worktrees grow.");
    expect(interactions.events[0]).toContain(
      "Workspace wald-project · Current main (main) · 1 worktree",
    );
    expect(interactions.events[1]).toBe("prompt");
    expect(interactions.selectCalls[0]).toMatchObject({
      navigation: "exit",
      options: expect.arrayContaining([
        expect.objectContaining({
          label: "🌱 Create worktree",
          description: "Create an isolated checkout for a branch.",
          group: "Common",
        }),
        expect.objectContaining({
          label: "Run lifecycle hook",
          description: "Run a configured hook without changing Git state.",
          group: "Project automation",
        }),
        expect.objectContaining({
          label: "Hand off current work",
          group: "Common",
        }),
        expect.objectContaining({
          label: "Rename worktree",
          group: "Maintenance",
        }),
      ]),
    });
  });

  it("runs guided handoff and rename only when their context is available", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    const current = { name: "main", branch: "main" } as Worktree;
    const linked = { name: "feature", branch: "feature/work", role: "linked" } as Worktree;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = [
      "handoff",
      new PromptBackError(),
      "rename",
      new PromptBackError(),
      "exit",
    ];

    await runMainMenu(new Command().name("wald"), createContext(current, [current, linked]));

    expect(interactions.handoffWorktree).toHaveBeenCalledWith(
      { cd: false, open: false, printPath: false },
      expect.anything(),
    );
    expect(interactions.renameWorktree).toHaveBeenCalledWith({}, expect.anything());
  });

  it("hides handoff outside a worktree and rename without a valid target", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);

    await runMainMenu(new Command().name("wald"), createContext(null, []));

    const labels = interactions.selectCalls[0]?.options.map((option) => option.label) ?? [];
    expect(labels).not.toContain("Hand off current work");
    expect(labels).not.toContain("Rename worktree");
  });

  it("keeps action output visible until Escape refreshes the menu", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["create", new PromptBackError(), "exit"];
    interactions.createWorktree.mockResolvedValue({ name: "feature" });
    const context = createContext(null, []);

    await runMainMenu(new Command().name("wald"), context);

    expect(interactions.createWorktree).toHaveBeenCalledOnce();
    expect(interactions.findWorkspaceOrNull).toHaveBeenCalledTimes(2);
    expect(interactions.events.filter((event) => event === "prompt")).toHaveLength(3);
    expect(interactions.selectCalls[1]).toMatchObject({
      navigation: "back",
      options: [
        {
          label: "Exit",
          description: "Close the interactive Wald session.",
        },
      ],
    });
  });

  it("keeps the worktree list visible until Escape returns to the menu", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["list", new PromptBackError(), "exit"];
    const context = createContext(null, []);

    await runMainMenu(new Command().name("wald"), context);

    expect(interactions.listWorktrees).toHaveBeenCalledWith({ json: false }, context);
    expect(interactions.findWorkspaceOrNull).toHaveBeenCalledTimes(2);
    expect(interactions.events.filter((event) => event === "prompt")).toHaveLength(3);
    expect(interactions.selectCalls[1]).toMatchObject({
      navigation: "back",
      options: [
        {
          label: "Exit",
          description: "Close the interactive Wald session.",
        },
      ],
    });
  });

  it("exits from the worktree list without reopening the main menu", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["list", "exit"];
    const context = createContext(null, []);

    await runMainMenu(new Command().name("wald"), context);

    expect(interactions.listWorktrees).toHaveBeenCalledOnce();
    expect(interactions.findWorkspaceOrNull).toHaveBeenCalledOnce();
    expect(interactions.events.filter((event) => event === "prompt")).toHaveLength(2);
  });

  it("keeps an expected action error visible until the result view is closed", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["create", "exit"];
    interactions.createWorktree.mockRejectedValue(new WaldError("Creation failed."));

    await runMainMenu(new Command().name("wald"), createContext(null, []));

    expect(interactions.events.join("\n")).toContain("Error: Creation failed.");
    expect(interactions.findWorkspaceOrNull).toHaveBeenCalledOnce();
    expect(interactions.events.filter((event) => event === "prompt")).toHaveLength(2);
  });

  it("returns from a nested prompt and exits cleanly from the main menu", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["create", new PromptBackError()];
    interactions.createWorktree.mockRejectedValue(new PromptBackError());

    await runMainMenu(new Command().name("wald"), createContext(null, []));

    expect(interactions.createWorktree).toHaveBeenCalledOnce();
    expect(interactions.events.filter((event) => event === "prompt")).toHaveLength(2);
  });

  it("runs the general lifecycle hook flow from the main menu", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    const current = { name: "main", branch: "main" } as Worktree;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["hook", "exit"];

    await runMainMenu(new Command().name("wald"), createContext(current, [current]));

    expect(interactions.runProjectHook).toHaveBeenCalledWith({}, expect.anything());
  });

  it("closes the menu after the workspace is uninitialized", async () => {
    const workspace = { root: "/tmp/wald-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["uninit"];
    interactions.uninitializeWorkspace.mockResolvedValue(true);

    await runMainMenu(new Command().name("wald"), createContext(null, []));

    expect(interactions.uninitializeWorkspace).toHaveBeenCalledWith(
      { apply: true, force: false, yes: false, json: false },
      expect.anything(),
    );
    expect(interactions.findWorkspaceOrNull).toHaveBeenCalledOnce();
  });

  it("shows the welcome page before starting guided initialization", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(null);

    await runMainMenu(new Command().name("wald"), createContext(null, []));

    expect(interactions.events[0]).toContain("Where Git worktrees grow.");
    expect(interactions.events[0]).not.toContain("Workspace");
    expect(interactions.events[1]).toBe("init");
    expect(interactions.events).not.toContain("prompt");
  });

  it("prints only help without a TTY", async () => {
    interactions.interactive = false;
    const program = new Command().name("wald").description("Wald help");

    await runMainMenu(program, createContext(null, []));

    const output = interactions.events.join("\n");
    expect(output).toContain("Usage: wald");
    expect(output).not.toContain("Where Git worktrees grow.");
    expect(interactions.findWorkspaceOrNull).not.toHaveBeenCalled();
  });
});

function createContext(current: Worktree | null, worktrees: Worktree[]): CliContext {
  const output = {
    write(chunk: string | Uint8Array): boolean {
      interactions.events.push(stripVTControlCharacters(chunk.toString()));
      return true;
    },
  } as NodeJS.WritableStream;

  return {
    output: { stdout: output, stderr: output },
    worktrees: {
      current: vi.fn().mockResolvedValue(current),
      list: vi.fn().mockResolvedValue(worktrees),
      listMoveCandidates: vi
        .fn()
        .mockResolvedValue(worktrees.filter((worktree) => worktree.role !== "primary")),
    },
  } as unknown as CliContext;
}
