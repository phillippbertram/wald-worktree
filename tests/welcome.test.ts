import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { renderWelcome, selectWisdom } from "../src/ui/welcome.js";

describe("welcome page", () => {
  it("renders the tree, current worktree, singular count, and selected wisdom", () => {
    const output = plain(
      renderWelcome(
        {
          workspaceRoot: "/Users/example/dev/wald-worktree",
          current: { name: "main", branch: "main" },
          worktreeCount: 1,
        },
        () => 0,
      ),
    );

    expect(output).toContain(["      🌲  🌳  🌲", "          Wald"].join("\n"));
    expect(output).toContain("Where Git worktrees grow.");
    expect(output).toContain("Workspace wald-worktree · Current main (main) · 1 worktree");
    expect(output).toContain("“Every tree grows stronger in shared ground.”");
  });

  it("renders detached worktrees and a plural count", () => {
    const output = plain(
      renderWelcome({
        workspaceRoot: "/tmp/project",
        current: { name: "experiment", branch: null },
        worktreeCount: 3,
      }),
    );

    expect(output).toContain("Workspace project · Current experiment (detached) · 3 worktrees");
  });

  it("identifies the workspace root when no worktree is current", () => {
    const output = plain(
      renderWelcome({ workspaceRoot: "/tmp/project", current: null, worktreeCount: 0 }),
    );

    expect(output).toContain("Workspace project · Current workspace root · 0 worktrees");
  });

  it("omits workspace metadata outside a workspace", () => {
    const output = plain(renderWelcome(null, () => 0));

    expect(output).toContain("🌲  🌳  🌲");
    expect(output).toContain("Where Git worktrees grow.");
    expect(output).not.toContain("Workspace");
    expect(output).not.toContain("Current");
  });

  it("selects the first and last wisdom deterministically", () => {
    expect(selectWisdom(() => 0)).toBe("Every tree grows stronger in shared ground.");
    expect(selectWisdom(() => 0.999_999)).toBe("Grow experiments freely; prune with care.");
  });
});

function plain(value: string): string {
  return stripVTControlCharacters(value);
}
