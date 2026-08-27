import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../src/cli/context.js";
import { runMainMenu } from "../src/cli/main-menu.js";
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
    interactions.uninitializeWorkspace.mockReset();
  });

  it("shows workspace context before prompting", async () => {
    const workspace = { root: "/tmp/ygg-project" } as Workspace;
    const current = {
      name: "main",
      branch: "main",
    } as Worktree;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    const context = createContext(current, [current]);

    await runMainMenu(new Command().name("ygg"), context);

    expect(interactions.events[0]).toContain("Git workspaces, rooted together.");
    expect(interactions.events[0]).toContain(
      "Workspace ygg-project · Current main (main) · 1 worktree",
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
      ]),
    });
  });

  it("refreshes workspace state and returns to the menu after an action", async () => {
    const workspace = { root: "/tmp/ygg-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["create", "exit"];
    interactions.createWorktree.mockResolvedValue({ name: "feature" });
    const context = createContext(null, []);

    await runMainMenu(new Command().name("ygg"), context);

    expect(interactions.createWorktree).toHaveBeenCalledOnce();
    expect(interactions.findWorkspaceOrNull).toHaveBeenCalledTimes(2);
    expect(interactions.events.filter((event) => event === "prompt")).toHaveLength(2);
  });

  it("returns from a nested prompt and exits cleanly from the main menu", async () => {
    const workspace = { root: "/tmp/ygg-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["create", new PromptBackError()];
    interactions.createWorktree.mockRejectedValue(new PromptBackError());

    await runMainMenu(new Command().name("ygg"), createContext(null, []));

    expect(interactions.createWorktree).toHaveBeenCalledOnce();
    expect(interactions.events.filter((event) => event === "prompt")).toHaveLength(2);
  });

  it("closes the menu after the workspace is uninitialized", async () => {
    const workspace = { root: "/tmp/ygg-project" } as Workspace;
    interactions.findWorkspaceOrNull.mockResolvedValue(workspace);
    interactions.selections = ["uninit"];
    interactions.uninitializeWorkspace.mockResolvedValue(true);

    await runMainMenu(new Command().name("ygg"), createContext(null, []));

    expect(interactions.uninitializeWorkspace).toHaveBeenCalledWith(
      { apply: true, force: false, yes: false },
      expect.anything(),
    );
    expect(interactions.findWorkspaceOrNull).toHaveBeenCalledOnce();
  });

  it("shows the welcome page before starting guided initialization", async () => {
    interactions.findWorkspaceOrNull.mockResolvedValue(null);

    await runMainMenu(new Command().name("ygg"), createContext(null, []));

    expect(interactions.events[0]).toContain("Git workspaces, rooted together.");
    expect(interactions.events[0]).not.toContain("Workspace");
    expect(interactions.events[1]).toBe("init");
    expect(interactions.events).not.toContain("prompt");
  });

  it("prints only help without a TTY", async () => {
    interactions.interactive = false;
    const program = new Command().name("ygg").description("Ygg help");

    await runMainMenu(program, createContext(null, []));

    const output = interactions.events.join("\n");
    expect(output).toContain("Usage: ygg");
    expect(output).not.toContain("Git workspaces, rooted together.");
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
    },
  } as unknown as CliContext;
}
