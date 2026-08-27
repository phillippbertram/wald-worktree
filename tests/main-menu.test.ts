import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../src/cli/context.js";
import { runMainMenu } from "../src/cli/main-menu.js";
import type { Workspace, Worktree } from "../src/domain/types.js";

const interactions = vi.hoisted(() => ({
  interactive: true,
  selection: "exit" as string | null,
  events: [] as string[],
  findWorkspaceOrNull: vi.fn(),
  initializeWorkspace: vi.fn(),
}));

vi.mock("../src/ui/terminal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/terminal.js")>();
  return {
    ...actual,
    isInteractiveTerminal: () => interactions.interactive,
    searchSelect: async () => {
      interactions.events.push("prompt");
      return interactions.selection;
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

describe("interactive main menu", () => {
  beforeEach(() => {
    interactions.interactive = true;
    interactions.selection = "exit";
    interactions.events = [];
    interactions.findWorkspaceOrNull.mockReset();
    interactions.initializeWorkspace.mockReset();
    interactions.initializeWorkspace.mockImplementation(async () => {
      interactions.events.push("init");
    });
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
