import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfigDocument, Workspace, Worktree } from "../src/domain/types.js";
import type { GitClient } from "../src/infrastructure/git-client.js";
import { ConfigService } from "../src/services/config-service.js";

const workspace = {
  config: {
    defaultBranch: "main",
    remote: { name: "origin" },
  },
} as Workspace;
const document = { path: ".wald.yml" } as ProjectConfigDocument;
const git = {} as GitClient;

describe("effective project configuration resolution", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the current worktree before any workspace fallback", async () => {
    const configs = new ConfigService();
    const current = worktree("feature", "linked");
    const resolvePath = vi.spyOn(configs, "resolveProjectConfig").mockResolvedValue(document);
    const resolveRevision = vi
      .spyOn(configs, "resolveProjectConfigAtRevision")
      .mockResolvedValue(document);

    await expect(
      configs.resolveEffectiveProjectConfig(git, workspace, current, [
        worktree("main", "linked"),
        current,
      ]),
    ).resolves.toBe(document);
    expect(resolvePath).toHaveBeenCalledWith(workspace, current.path);
    expect(resolveRevision).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "default branch",
      worktrees: [worktree("feature", "primary"), worktree("main", "linked")],
      expected: "/workspace/main",
    },
    {
      name: "primary checkout",
      worktrees: [worktree("feature", "primary"), worktree("review", "linked")],
      expected: "/workspace/feature",
    },
    {
      name: "first checkout",
      worktrees: [worktree("feature", "linked"), worktree("review", "linked")],
      expected: "/workspace/feature",
    },
  ])("uses the $name fallback from the workspace root", async ({ worktrees, expected }) => {
    const configs = new ConfigService();
    const resolvePath = vi.spyOn(configs, "resolveProjectConfig").mockResolvedValue(document);

    await expect(
      configs.resolveEffectiveProjectConfig(git, workspace, null, worktrees),
    ).resolves.toBe(document);
    expect(resolvePath).toHaveBeenCalledWith(workspace, expected);
  });

  it("falls back to the configured remote default revision without worktrees", async () => {
    const configs = new ConfigService();
    const resolveRevision = vi
      .spyOn(configs, "resolveProjectConfigAtRevision")
      .mockResolvedValue(document);

    await expect(configs.resolveEffectiveProjectConfig(git, workspace, null, [])).resolves.toBe(
      document,
    );
    expect(resolveRevision).toHaveBeenCalledWith(git, workspace, "origin/main");
  });
});

function worktree(branch: string, role: Worktree["role"]): Worktree {
  return {
    name: branch,
    path: `/workspace/${branch}`,
    head: "abc123",
    branch,
    branchRef: `refs/heads/${branch}`,
    role,
    state: "clean",
    locked: false,
    lockReason: null,
    prunable: false,
  };
}
