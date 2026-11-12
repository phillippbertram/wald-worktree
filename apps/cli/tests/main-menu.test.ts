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
  worktreeSelections: [] as Array<Worktree | Error>,
  openWorktree: vi.fn(),
  runProjectTask: vi.fn(),
  runDoctor: vi.fn(),
  selections: [] as Array<string | Error>,
  selectCalls: [] as Array<{
    options: Array<{ label: string; value: string; description?: string; group?: string }>;
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
    selectWorktree: async () => {
      const selected = interactions.worktreeSelections.shift();
      if (selected instanceof Error) throw selected;
      if (!selected) throw new PromptBackError();
      return selected;
    },
    selectValue: async (
      _question: string,
      options: Array<{ label: string; value: string; description?: string; group?: string }>,
      promptOptions?: { navigation?: string },
    ) => {
      interactions.events.push("prompt");
      interactions.selectCalls.push({ options, navigation: promptOptions?.navigation });
      const selection = interactions.selections.shift() ?? "exit";
      if (selection instanceof Error) throw selection;
      if (!options.some((option) => option.value === selection))
        throw new Error(`Selection not offered: ${selection}`);
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

vi.mock("../src/cli/commands/open.js", () => ({ openWorktree: interactions.openWorktree }));
vi.mock("../src/cli/commands/run.js", () => ({ runProjectTask: interactions.runProjectTask }));
vi.mock("../src/cli/commands/doctor.js", () => ({ runDoctor: interactions.runDoctor }));

describe("interactive main menu", () => {
  beforeEach(() => {
    interactions.interactive = true;
    interactions.worktreeSelections = [];
    interactions.openWorktree.mockReset();
    interactions.runProjectTask.mockReset();
    interactions.runDoctor.mockReset();
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

  const workspace = { root: "/tmp/wald-project" } as Workspace;
  const primary = {
    name: "main",
    branch: "main",
    path: "/tmp/wald-project/main",
    role: "primary",
    state: "clean",
  } as Worktree;
  const feature = {
    name: "feature",
    branch: "feature/work",
    path: "/tmp/wald-project/feature",
    role: "linked",
    state: "clean",
  } as Worktree;

  it("keeps the first menu to seven task-oriented actions", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    await runMainMenu(new Command().name("wald"), createContext(primary, [primary, feature]));
    expect(interactions.events[0]).toContain(
      "Workspace wald-project · Current main (main) · 2 worktrees",
    );
    expect(interactions.selectCalls[0]?.options.map(({ value }) => value)).toEqual([
      "create",
      "worktrees",
      "handoff",
      "tasks",
      "settings",
      "maintenance",
      "exit",
    ]);
    expect(interactions.selectCalls[0]?.navigation).toBe("exit");
  });

  it("hides current-work handoff outside a checkout", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    await runMainMenu(new Command().name("wald"), createContext(null, []));
    expect(interactions.selectCalls[0]?.options.map(({ value }) => value)).not.toContain("handoff");
  });

  it.each(["back", new PromptBackError()])(
    "refreshes context without repeating the welcome after returning: %s",
    async (back) => {
      interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
      interactions.selections = ["create", back, "exit"];
      interactions.createWorktree.mockResolvedValue(feature);
      await runMainMenu(new Command().name("wald"), createContext(primary, [primary]));
      expect(interactions.findWorkspaceOrNull).toHaveBeenCalledTimes(2);
      expect(
        interactions.events.filter((event) => event.includes("Where Git worktrees grow.")),
      ).toHaveLength(1);
      expect(interactions.selectCalls[1]?.options.map(({ value }) => value)).toEqual([
        "open",
        "navigate",
        "back",
        "exit",
      ]);
    },
  );

  it("opens the created worktree directly from its result", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["create", "open", "navigate", "exit"];
    interactions.createWorktree.mockResolvedValue(feature);
    await runMainMenu(new Command().name("wald"), createContext(primary, [primary]));
    expect(interactions.openWorktree).toHaveBeenCalledWith(
      feature.path,
      undefined,
      expect.anything(),
    );
    expect(interactions.events.join("\n")).toContain(`cd '${feature.path}'`);
  });

  it("keeps operational errors visible and provides a way back", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["create", "exit"];
    interactions.createWorktree.mockRejectedValue(new WaldError("Creation failed."));
    await runMainMenu(new Command().name("wald"), createContext(null, []));
    expect(interactions.events.join("\n")).toContain("Error: Creation failed.");
    expect(interactions.selectCalls[1]?.options.map(({ value }) => value)).toEqual([
      "back",
      "exit",
    ]);
  });

  it("returns from a cancelled command straight to the menu", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["create", new PromptBackError()];
    interactions.createWorktree.mockRejectedValue(new PromptBackError());
    await runMainMenu(new Command().name("wald"), createContext(null, []));
    expect(interactions.selectCalls).toHaveLength(2);
  });

  it("selects a worktree before opening, even inside the primary checkout", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.worktreeSelections = [feature];
    interactions.selections = ["worktrees", "open", "exit"];
    await runMainMenu(new Command().name("wald"), createContext(primary, [primary, feature]));
    expect(interactions.openWorktree).toHaveBeenCalledWith(
      feature.path,
      undefined,
      expect.anything(),
    );
  });

  it("does not offer rename or removal for the primary checkout", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.worktreeSelections = [primary, new PromptBackError()];
    interactions.selections = ["worktrees", "back", "exit"];
    await runMainMenu(new Command().name("wald"), createContext(primary, [primary, feature]));
    expect(interactions.selectCalls[1]?.options.map(({ value }) => value)).not.toEqual(
      expect.arrayContaining(["rename", "remove"]),
    );
  });

  it("returns from worktree actions to selection before the main menu", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.worktreeSelections = [feature, new PromptBackError()];
    interactions.selections = ["worktrees", new PromptBackError(), "exit"];
    await runMainMenu(new Command().name("wald"), createContext(primary, [primary, feature]));
    expect(interactions.findWorkspaceOrNull).toHaveBeenCalledTimes(2);
    expect(interactions.openWorktree).not.toHaveBeenCalled();
  });

  it("chooses a target before running project tasks", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.worktreeSelections = [feature];
    interactions.selections = ["tasks", "exit"];
    await runMainMenu(new Command().name("wald"), createContext(primary, [primary, feature]));
    expect(interactions.runProjectTask).toHaveBeenCalledWith(
      { worktree: feature.path },
      expect.anything(),
    );
  });

  it("provides listing and diagnostics in maintenance", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["maintenance", "list", "back", "doctor", "exit"];
    const context = createContext(null, []);
    await runMainMenu(new Command().name("wald"), context);
    expect(interactions.listWorktrees).toHaveBeenCalledWith({ json: false }, context);
    expect(interactions.runDoctor).toHaveBeenCalledWith({ json: false, verbose: false }, context);
  });

  it("runs lifecycle hooks through advanced automation for a selected target", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.worktreeSelections = [feature];
    interactions.selections = ["maintenance", "advanced", "hook", "exit"];
    await runMainMenu(new Command().name("wald"), createContext(primary, [primary, feature]));
    expect(interactions.runProjectHook).toHaveBeenCalledWith(
      { worktree: feature.path },
      expect.anything(),
    );
  });

  it("shows shell setup instructions without modifying a shell profile", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["settings", "shell", "exit"];
    await runMainMenu(new Command().name("wald"), createContext(null, []));
    expect(interactions.events.join("\n")).toContain('eval "$(wald completion zsh)"');
  });

  it("closes the session after disconnecting the workspace", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["maintenance", "uninit"];
    interactions.uninitializeWorkspace.mockResolvedValue(true);
    await runMainMenu(new Command().name("wald"), createContext(null, []));
    expect(interactions.uninitializeWorkspace).toHaveBeenCalledWith(
      { apply: true, force: false, yes: false, json: false },
      expect.anything(),
    );
  });

  it("shows the welcome before initializing outside a workspace", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(null);
    await runMainMenu(new Command().name("wald"), createContext(null, []));
    expect(interactions.events[0]).toContain("Where Git worktrees grow.");
    expect(interactions.events[1]).toBe("init");
  });

  it("prints only help without a TTY", async () => {
    interactions.interactive = false;
    await runMainMenu(new Command().name("wald").description("Wald help"), createContext(null, []));
    expect(interactions.events.join("\n")).toContain("Usage: wald");
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
    workspaces: { find: vi.fn().mockResolvedValue({ root: "/tmp/wald-project" }) },
    worktrees: {
      current: vi.fn().mockResolvedValue(current),
      list: vi.fn().mockResolvedValue(worktrees),
      listMoveCandidates: vi
        .fn()
        .mockResolvedValue(worktrees.filter((worktree) => worktree.role !== "primary")),
    },
  } as unknown as CliContext;
}
