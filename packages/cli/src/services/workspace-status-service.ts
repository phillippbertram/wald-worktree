import { WaldError } from "../domain/errors.js";
import type {
  Workspace,
  WorkspaceStatus,
  Worktree,
  WorktreeState,
  WorktreeTracking,
} from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";
import type { ConfigService } from "./config-service.js";
import type { WorktreeService } from "./worktree-service.js";

export class WorkspaceStatusService {
  constructor(
    private readonly git: GitClient,
    private readonly worktrees: WorktreeService,
    private readonly configs: ConfigService,
  ) {}

  async inspect(workspace: Workspace, cwd = process.cwd()): Promise<WorkspaceStatus> {
    const worktrees = await this.worktrees.list(workspace);
    const current = await this.worktrees.currentFromList(worktrees, cwd);
    const [project, tracking] = await Promise.all([
      this.configs.resolveEffectiveProjectConfig(this.git, workspace, current, worktrees),
      this.inspectTracking(workspace, current),
    ]);

    return {
      workspace: {
        root: workspace.root,
        defaultBranch: workspace.config.defaultBranch,
      },
      current: current
        ? {
            name: current.name,
            path: current.path,
            branch: current.branch,
            role: current.role,
            state: current.state,
            head: current.head,
            tracking,
          }
        : null,
      project: project
        ? {
            path: project.path,
            sources: project.sources,
            trust: !project.requiresTrust
              ? "not-required"
              : this.configs.isTrusted(workspace, project)
                ? "trusted"
                : "untrusted",
          }
        : null,
      worktrees: countWorktreeStates(worktrees),
    };
  }

  private async inspectTracking(
    workspace: Workspace,
    current: Worktree | null,
  ): Promise<WorktreeTracking> {
    if (!current?.branchRef) return noTracking("not-applicable");

    const upstreamResult = await this.git.run(
      ["for-each-ref", "--format=%(upstream:short)", current.branchRef],
      { gitDir: workspace.gitDir },
    );
    const upstream = upstreamResult.stdout.trim();
    if (!upstream) return noTracking("none");

    const upstreamExists = await this.git.succeeds(
      ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`],
      { gitDir: workspace.gitDir },
    );
    if (!upstreamExists) {
      return { state: "gone", upstream, ahead: null, behind: null };
    }

    const comparison = await this.git.run(
      ["rev-list", "--left-right", "--count", `${upstream}...${current.branchRef}`],
      { gitDir: workspace.gitDir },
    );
    const [behindValue, aheadValue, ...unexpected] = comparison.stdout.trim().split(/\s+/u);
    if (
      unexpected.length > 0 ||
      !behindValue ||
      !aheadValue ||
      !/^\d+$/u.test(behindValue) ||
      !/^\d+$/u.test(aheadValue)
    ) {
      throw new WaldError(`Git returned invalid tracking counts for ${current.branch}.`);
    }

    return {
      state: "tracked",
      upstream,
      ahead: Number(aheadValue),
      behind: Number(behindValue),
    };
  }
}

function noTracking(state: "none" | "not-applicable"): WorktreeTracking {
  return { state, upstream: null, ahead: null, behind: null };
}

function countWorktreeStates(
  worktrees: Worktree[],
): Record<WorktreeState, number> & { total: number } {
  const counts = {
    total: worktrees.length,
    clean: 0,
    modified: 0,
    locked: 0,
    missing: 0,
    unavailable: 0,
  };
  for (const worktree of worktrees) counts[worktree.state] += 1;
  return counts;
}
