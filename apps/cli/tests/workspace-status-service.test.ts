import { describe, expect, it, vi } from "vitest";
import type { ProjectConfigDocument, Workspace, Worktree } from "../src/domain/types.js";
import type { GitClient } from "../src/infrastructure/git-client.js";
import type { ConfigService } from "../src/services/config-service.js";
import { WorkspaceStatusService } from "../src/services/workspace-status-service.js";
import type { WorktreeService } from "../src/services/worktree-service.js";

const workspace = {
  root: "/workspace",
  gitDir: "/workspace/repo.git",
  config: {
    defaultBranch: "main",
    trustedProjectConfig: null,
  },
} as Workspace;

describe("workspace status service", () => {
  it("builds one current-context report from a single worktree inventory", async () => {
    const current = worktree("main", "clean", {
      branch: "main",
      branchRef: "refs/heads/main",
      role: "primary",
    });
    const worktrees = [
      current,
      worktree("feature", "modified"),
      worktree("portable", "locked"),
      worktree("deleted", "missing"),
    ];
    const project = {
      path: "/workspace/main/.wald.yml",
      sources: {
        repository: "/workspace/main/.wald.yml",
        workspace: "/workspace/.wald/project.yml",
      },
      requiresTrust: true,
    } as ProjectConfigDocument;
    const git = gitClient({ upstream: "origin/main", counts: "2\t3" });
    const worktreeService = {
      list: vi.fn().mockResolvedValue(worktrees),
      currentFromList: vi.fn().mockResolvedValue(current),
    };
    const configs = {
      resolveEffectiveProjectConfig: vi.fn().mockResolvedValue(project),
      isTrusted: vi.fn().mockReturnValue(false),
    };
    const service = statusService(git, worktreeService, configs);

    await expect(service.inspect(workspace, "/workspace/main/src")).resolves.toEqual({
      workspace: { root: "/workspace", defaultBranch: "main" },
      current: {
        name: "main",
        path: "/workspace/main",
        branch: "main",
        role: "primary",
        state: "clean",
        head: "abc123",
        tracking: {
          state: "tracked",
          upstream: "origin/main",
          ahead: 3,
          behind: 2,
        },
      },
      project: {
        path: project.path,
        sources: project.sources,
        trust: "untrusted",
      },
      worktrees: {
        total: 4,
        clean: 1,
        modified: 1,
        locked: 1,
        missing: 1,
        unavailable: 0,
      },
    });
    expect(worktreeService.list).toHaveBeenCalledOnce();
    expect(worktreeService.currentFromList).toHaveBeenCalledWith(worktrees, "/workspace/main/src");
    expect(git.run).not.toHaveBeenCalledWith(expect.arrayContaining(["fetch"]), expect.anything());
  });

  it.each([
    {
      name: "workspace root",
      current: null,
      git: gitClient(),
      expected: { state: "not-applicable", upstream: null, ahead: null, behind: null },
    },
    {
      name: "detached HEAD",
      current: worktree("detached", "clean", { branch: null, branchRef: null }),
      git: gitClient(),
      expected: { state: "not-applicable", upstream: null, ahead: null, behind: null },
    },
    {
      name: "branch without upstream",
      current: worktree("local", "clean"),
      git: gitClient({ upstream: "" }),
      expected: { state: "none", upstream: null, ahead: null, behind: null },
    },
    {
      name: "missing upstream ref",
      current: worktree("gone", "clean"),
      git: gitClient({ upstream: "origin/gone", upstreamExists: false }),
      expected: { state: "gone", upstream: "origin/gone", ahead: null, behind: null },
    },
  ])("reports $name tracking", async ({ current, git, expected }) => {
    const worktrees = current ? [current] : [];
    const service = statusService(
      git,
      {
        list: vi.fn().mockResolvedValue(worktrees),
        currentFromList: vi.fn().mockResolvedValue(current),
      },
      {
        resolveEffectiveProjectConfig: vi.fn().mockResolvedValue(null),
        isTrusted: vi.fn(),
      },
    );

    const status = await service.inspect(workspace);

    expect(status.current?.tracking ?? expected).toEqual(expected);
    if (!current?.branchRef) expect(git.run).not.toHaveBeenCalled();
  });

  it.each([
    { requiresTrust: false, trusted: false, expected: "not-required" },
    { requiresTrust: true, trusted: true, expected: "trusted" },
    { requiresTrust: true, trusted: false, expected: "untrusted" },
  ] as const)("maps project trust to $expected", async ({ requiresTrust, trusted, expected }) => {
    const current = worktree("main", "clean");
    const project = {
      path: "/workspace/main/.wald.yml",
      sources: { repository: "/workspace/main/.wald.yml", workspace: null },
      requiresTrust,
    } as ProjectConfigDocument;
    const service = statusService(
      gitClient({ upstream: "" }),
      {
        list: vi.fn().mockResolvedValue([current]),
        currentFromList: vi.fn().mockResolvedValue(current),
      },
      {
        resolveEffectiveProjectConfig: vi.fn().mockResolvedValue(project),
        isTrusted: vi.fn().mockReturnValue(trusted),
      },
    );

    expect((await service.inspect(workspace)).project?.trust).toBe(expected);
  });

  it("rejects malformed Git tracking counts", async () => {
    const current = worktree("main", "clean");
    const service = statusService(
      gitClient({ upstream: "origin/main", counts: "unexpected" }),
      {
        list: vi.fn().mockResolvedValue([current]),
        currentFromList: vi.fn().mockResolvedValue(current),
      },
      {
        resolveEffectiveProjectConfig: vi.fn().mockResolvedValue(null),
        isTrusted: vi.fn(),
      },
    );

    await expect(service.inspect(workspace)).rejects.toThrow(
      "Git returned invalid tracking counts for main.",
    );
  });
});

function statusService(
  git: ReturnType<typeof gitClient>,
  worktrees: object,
  configs: object,
): WorkspaceStatusService {
  return new WorkspaceStatusService(
    git as unknown as GitClient,
    worktrees as WorktreeService,
    configs as ConfigService,
  );
}

function gitClient(options: { upstream?: string; upstreamExists?: boolean; counts?: string } = {}) {
  const run = vi.fn(async (args: string[]) => ({
    stdout: args[0] === "for-each-ref" ? (options.upstream ?? "") : (options.counts ?? "0\t0"),
    stderr: "",
    exitCode: 0,
  }));
  return {
    run,
    succeeds: vi.fn().mockResolvedValue(options.upstreamExists ?? true),
  };
}

function worktree(
  name: string,
  state: Worktree["state"],
  overrides: Partial<Worktree> = {},
): Worktree {
  return {
    name,
    path: `/workspace/${name}`,
    head: "abc123",
    branch: name,
    branchRef: `refs/heads/${name}`,
    role: "linked",
    state,
    locked: false,
    lockReason: null,
    prunable: false,
    ...overrides,
  };
}
