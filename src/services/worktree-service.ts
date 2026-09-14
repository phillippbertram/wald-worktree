import fs from "node:fs/promises";
import path from "node:path";
import { toErrorMessage, WaldError } from "../domain/errors.js";
import type { Workspace, Worktree, WorktreeState } from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";
import { isPathInside } from "../infrastructure/path-utils.js";

export type ParsedWorktree = Omit<Worktree, "name" | "role" | "state"> & { bare: boolean };

export type AddWorktreeOptions = {
  branch: string;
  from?: string;
  name?: string;
  fetch?: boolean;
  newBranchOnly?: boolean;
};

export type PreparedAddWorktree = {
  branch: string;
  branchRef: string;
  target: string;
  projectRevision: string;
  strategy:
    | { type: "local" }
    | { type: "remote"; remoteName: string }
    | { type: "new"; base: string };
};

export type BranchCandidate = {
  name: string;
  source: "local" | "remote";
  label: string;
};

export type ListWorktreeOptions = {
  expire?: string;
};

export type RemovalInspection = {
  worktree: Worktree;
  dirty: boolean;
  merged: boolean;
  blockers: string[];
  hardBlockers: string[];
  branchDeletion: BranchDeletionInspection;
};

export type BranchDeletionPlan = {
  branch: string;
  branchRef: string;
  expectedHead: string;
  mergedIntoDefault: boolean;
};

export type BranchDeletionInspection =
  | ({ eligible: true } & BranchDeletionPlan)
  | { eligible: false; branch: string | null; reason: string };

export type MoveWorktreePlan = {
  worktree: Worktree;
  target: string;
  cwd: string;
  worktreeRoot: string;
  gitPath: string;
  directoryId: string;
  tracking: BranchTracking;
  options: RenameWorktreeOptions;
  branchChange: {
    before: string | null;
    after: string | null;
    renamed: boolean;
    upstream: string | null;
  };
};

export type RenameWorktreeOptions = {
  branch?: string;
  keepBranch?: boolean;
};

type BranchTracking = {
  remote: string;
  merge: string;
  upstream: string | null;
  upstreamRef: string | null;
};

export class WorktreeService {
  constructor(private readonly git: GitClient) {}

  async list(workspace: Workspace, options: ListWorktreeOptions = {}): Promise<Worktree[]> {
    const parsed = (await listWorktreePorcelain(this.git, workspace.gitDir, options)).filter(
      (worktree) => !worktree.bare,
    );

    return await Promise.all(
      parsed.map(async (worktree): Promise<Worktree> => {
        const state = await this.readState(worktree);
        return {
          ...worktree,
          name: path.basename(worktree.path),
          role:
            workspace.primaryWorktree &&
            (await canonicalPath(worktree.path)) === workspace.primaryWorktree
              ? "primary"
              : "linked",
          state,
        };
      }),
    );
  }

  async listPrunable(workspace: Workspace): Promise<Worktree[]> {
    return (await this.list(workspace, { expire: "now" })).filter(
      (worktree) => worktree.prunable && !worktree.locked && worktree.state === "missing",
    );
  }

  async prune(workspace: Workspace): Promise<void> {
    await this.git.run(["worktree", "prune", "--expire", "now"], {
      gitDir: workspace.gitDir,
    });
  }

  async add(workspace: Workspace, options: AddWorktreeOptions): Promise<Worktree> {
    return await this.createPrepared(workspace, await this.prepareAdd(workspace, options));
  }

  async prepareAdd(
    workspace: Workspace,
    options: AddWorktreeOptions,
  ): Promise<PreparedAddWorktree> {
    await this.validateBranch(workspace, options.branch);
    const directoryName = options.name ?? slugifyBranch(options.branch);
    validateWorktreeName(directoryName);

    const target = path.resolve(workspace.worktreeDir, directoryName);
    if (!isPathInside(workspace.worktreeDir, target)) {
      throw new WaldError("Worktree directory must stay inside the configured worktree root.");
    }
    if (target === workspace.gitDir) {
      throw new WaldError(`Reserved worktree directory: ${directoryName}`);
    }
    const remote = workspace.config.remote;
    if (options.fetch !== false && remote) {
      await this.git.run(["fetch", "--prune", "--tags", remote.name, remote.fetchRefspec], {
        gitDir: workspace.gitDir,
      });
    }

    const branchRef = `refs/heads/${options.branch}`;
    const remoteRef = remote ? `refs/remotes/${remote.name}/${options.branch}` : null;
    const worktrees = await this.list(workspace);
    const existingCheckout = worktrees.find((worktree) => worktree.branchRef === branchRef);
    if (existingCheckout) {
      throw new WaldError(
        `Branch ${options.branch} is already checked out at ${existingCheckout.path}`,
      );
    }
    if (await pathEntryExists(target)) {
      throw new WaldError(
        `Worktree directory already exists: ${target}. Choose another directory with --name <directory>.`,
      );
    }
    const portableCollision = await findPortableNameCollision(workspace.worktreeDir, directoryName);
    if (portableCollision) {
      throw new WaldError(
        `Worktree directory name conflicts with existing entry ${portableCollision} when compared case-insensitively: ${directoryName}. Choose another directory with --name <directory>.`,
      );
    }

    const localExists = await this.refExists(workspace, branchRef);
    const remoteExists = remoteRef ? await this.refExists(workspace, remoteRef) : false;

    if (options.newBranchOnly && (localExists || remoteExists)) {
      throw new WaldError(`Carry target must be a new branch: ${options.branch}`);
    }

    if (localExists) {
      return {
        branch: options.branch,
        branchRef,
        target,
        projectRevision: branchRef,
        strategy: { type: "local" },
      };
    }
    if (remoteExists && remote && remoteRef) {
      return {
        branch: options.branch,
        branchRef,
        target,
        projectRevision: remoteRef,
        strategy: { type: "remote", remoteName: remote.name },
      };
    }

    const base = await this.resolveBase(workspace, options.from);
    return {
      branch: options.branch,
      branchRef,
      target,
      projectRevision: base,
      strategy: { type: "new", base },
    };
  }

  async createPrepared(workspace: Workspace, prepared: PreparedAddWorktree): Promise<Worktree> {
    if (prepared.strategy.type === "local") {
      await this.git.run(["worktree", "add", prepared.target, prepared.branch], {
        gitDir: workspace.gitDir,
      });
    } else if (prepared.strategy.type === "remote") {
      await this.git.run(
        [
          "worktree",
          "add",
          "--track",
          "-b",
          prepared.branch,
          prepared.target,
          `${prepared.strategy.remoteName}/${prepared.branch}`,
        ],
        { gitDir: workspace.gitDir },
      );
    } else {
      await this.git.run(
        [
          "worktree",
          "add",
          "--no-track",
          "-b",
          prepared.branch,
          prepared.target,
          prepared.strategy.base,
        ],
        { gitDir: workspace.gitDir },
      );
    }

    const created = (await this.list(workspace)).find(
      (worktree) => worktree.branchRef === prepared.branchRef,
    );
    if (!created) {
      throw new WaldError(
        `Git created the worktree, but it could not be read back: ${prepared.target}`,
      );
    }
    return created;
  }

  async listBranchCandidates(workspace: Workspace): Promise<BranchCandidate[]> {
    const result = await this.git.run(
      ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
      { gitDir: workspace.gitDir },
    );
    const candidates: BranchCandidate[] = [];
    for (const reference of result.stdout.split("\n").filter(Boolean)) {
      if (reference.startsWith("refs/heads/")) {
        const name = reference.slice("refs/heads/".length);
        candidates.push({ name, source: "local", label: `${name}  local` });
        continue;
      }
      const remote = workspace.config.remote?.name;
      if (!remote || !reference.startsWith(`refs/remotes/${remote}/`)) {
        continue;
      }
      const name = reference.slice(`refs/remotes/${remote}/`.length);
      if (name === "HEAD") {
        continue;
      }
      candidates.push({ name, source: "remote", label: `${name}  ${remote}` });
    }
    return candidates.sort((left, right) => {
      const nameComparison = left.name.localeCompare(right.name);
      return nameComparison === 0 ? left.source.localeCompare(right.source) : nameComparison;
    });
  }

  async resolve(workspace: Workspace, identifier: string): Promise<Worktree> {
    const worktrees = await this.list(workspace);
    const directMatches = worktrees.filter(
      (worktree) => worktree.name === identifier || worktree.branch === identifier,
    );
    const resolvedIdentifier = await canonicalPath(path.resolve(workspace.worktreeDir, identifier));
    const pathMatches = (
      await Promise.all(
        worktrees.map(async (worktree) => ({
          worktree,
          matches: (await canonicalPath(worktree.path)) === resolvedIdentifier,
        })),
      )
    )
      .filter((candidate) => candidate.matches)
      .map((candidate) => candidate.worktree);
    const matches = [
      ...new Map([...directMatches, ...pathMatches].map((item) => [item.path, item])).values(),
    ];

    if (matches.length === 0) {
      throw new WaldError(`No worktree matches: ${identifier}`);
    }
    if (matches.length > 1) {
      throw new WaldError(`Worktree identifier is ambiguous: ${identifier}`);
    }
    return matches[0] as Worktree;
  }

  async current(workspace: Workspace, cwd = process.cwd()): Promise<Worktree | null> {
    return await this.currentFromList(await this.list(workspace), cwd);
  }

  async currentFromList(worktrees: Worktree[], cwd = process.cwd()): Promise<Worktree | null> {
    const currentPath = await canonicalPath(cwd);
    for (const worktree of worktrees) {
      const worktreePath = await canonicalPath(worktree.path);
      if (currentPath === worktreePath || isPathInside(worktreePath, currentPath)) {
        return worktree;
      }
    }
    return null;
  }

  async inspectRemoval(workspace: Workspace, identifier: string): Promise<RemovalInspection> {
    const worktree = await this.resolve(workspace, identifier);
    const dirty = worktree.state === "modified";
    const merged =
      worktree.role === "primary" || (await this.isMergedIntoDefault(workspace, worktree));
    const blockers: string[] = [];
    const hardBlockers: string[] = [];

    if (worktree.role === "primary") {
      hardBlockers.push("the primary checkout cannot be removed by wald");
    }
    if (worktree.state === "unavailable") {
      hardBlockers.push("the worktree state could not be read safely");
    }

    if (dirty) {
      blockers.push("the worktree contains staged, unstaged, or untracked changes");
    }
    if (!merged) {
      blockers.push(`the branch is not merged into ${workspace.config.defaultBranch}`);
    }
    if (worktree.locked) {
      blockers.push("the worktree is locked");
    }

    return {
      worktree,
      dirty,
      merged,
      blockers,
      hardBlockers,
      branchDeletion: this.inspectBranchDeletion(workspace, worktree, merged),
    };
  }

  async remove(workspace: Workspace, worktree: Worktree, force: boolean): Promise<void> {
    if (worktree.role === "primary") {
      throw new WaldError(`Refusing to remove the primary checkout: ${worktree.path}`);
    }
    const args = ["worktree", "remove"];
    if (force) {
      args.push("--force", "--force");
    }
    args.push(worktree.path);
    await this.git.run(args, { gitDir: workspace.gitDir });
  }

  async deleteBranch(
    workspace: Workspace,
    plan: BranchDeletionPlan,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (plan.branch === workspace.config.defaultBranch) {
      throw new WaldError(`Refusing to delete the configured default branch: ${plan.branch}`);
    }
    if (plan.branchRef !== `refs/heads/${plan.branch}`) {
      throw new WaldError(`Refusing to delete an unexpected branch reference: ${plan.branchRef}`);
    }

    const existingCheckout = (await this.list(workspace)).find(
      (worktree) => worktree.branchRef === plan.branchRef,
    );
    if (existingCheckout) {
      throw new WaldError(
        `Refusing to delete branch ${plan.branch}; it is checked out at ${existingCheckout.path}`,
      );
    }

    const current = await this.git.run(["rev-parse", "--verify", "--quiet", plan.branchRef], {
      gitDir: workspace.gitDir,
      reject: false,
    });
    if (current.exitCode !== 0) {
      return;
    }
    if (current.stdout !== plan.expectedHead) {
      throw new WaldError(
        `Refusing to delete branch ${plan.branch}; its HEAD changed after review.`,
      );
    }
    if (!(await this.isBranchMergedIntoDefault(workspace, plan.branchRef)) && !options.force) {
      throw new WaldError(
        `Refusing to delete branch ${plan.branch}; it is no longer merged into ${workspace.config.defaultBranch}.`,
      );
    }

    await this.git.run(["branch", "--delete", "--force", "--", plan.branch], {
      gitDir: workspace.gitDir,
    });
  }

  async listMoveCandidates(
    workspace: Workspace,
    cwd = process.cwd(),
    options: RenameWorktreeOptions = {},
  ): Promise<Worktree[]> {
    const worktrees = await this.list(workspace);
    const current = await this.currentFromList(worktrees, cwd);
    const worktreeRoot = await canonicalPath(workspace.worktreeDir);
    const candidates: Worktree[] = [];
    for (const worktree of worktrees) {
      if (
        worktree.role === "primary" ||
        worktree.path === current?.path ||
        worktree.state === "missing" ||
        worktree.state === "unavailable" ||
        worktree.locked ||
        (!options.keepBranch &&
          (!worktree.branch ||
            worktree.branch === workspace.config.defaultBranch ||
            worktrees.some(
              (other) => other.path !== worktree.path && other.branchRef === worktree.branchRef,
            ))) ||
        (await canonicalPath(path.dirname(worktree.path))) !== worktreeRoot ||
        (await this.hasSubmodules(worktree))
      ) {
        continue;
      }
      candidates.push(worktree);
    }
    return candidates;
  }

  async prepareMove(
    workspace: Workspace,
    identifier: string,
    newName: string,
    cwd = process.cwd(),
    options: RenameWorktreeOptions = {},
  ): Promise<MoveWorktreePlan> {
    if (options.branch !== undefined && options.keepBranch) {
      throw new WaldError("--branch and --keep-branch cannot be combined.");
    }
    validateWorktreeName(newName);
    const [worktree, current] = await Promise.all([
      this.resolve(workspace, identifier),
      this.current(workspace, cwd),
    ]);
    if (worktree.role === "primary") {
      throw new WaldError(`Refusing to rename the primary checkout: ${worktree.path}`);
    }
    if (worktree.path === current?.path) {
      throw new WaldError(
        `Refusing to rename the current worktree: ${worktree.path}. Run wald rename from the workspace or another worktree.`,
      );
    }
    if (worktree.state === "missing") {
      throw new WaldError(`Refusing to rename a missing worktree: ${worktree.path}`);
    }
    if (worktree.state === "unavailable") {
      throw new WaldError(
        `Refusing to rename a worktree whose state is unavailable: ${worktree.path}`,
      );
    }
    if (worktree.locked) {
      throw new WaldError(`Refusing to rename a locked worktree: ${worktree.path}`);
    }

    const worktreeRoot = await canonicalPath(workspace.worktreeDir);
    if ((await canonicalPath(path.dirname(worktree.path))) !== worktreeRoot) {
      throw new WaldError(
        `Refusing to rename a worktree outside the configured worktree root: ${worktree.path}`,
      );
    }
    if (await this.hasSubmodules(worktree)) {
      throw new WaldError(`Refusing to rename a worktree containing submodules: ${worktree.path}`);
    }

    const target = path.resolve(workspace.worktreeDir, newName);
    if (!isPathInside(workspace.worktreeDir, target)) {
      throw new WaldError("Worktree directory must stay inside the configured worktree root.");
    }
    if (target === worktree.path) {
      throw new WaldError(`Worktree is already named ${newName}.`);
    }
    if (await pathEntryExists(target)) {
      throw new WaldError(`Worktree directory already exists: ${target}`);
    }
    if ((await this.list(workspace)).some((candidate) => candidate.path === target)) {
      throw new WaldError(`Worktree destination is already registered with Git: ${target}`);
    }
    const portableCollision = await findPortableNameCollision(workspace.worktreeDir, newName);
    if (portableCollision) {
      throw new WaldError(`Worktree directory conflicts with existing entry: ${portableCollision}`);
    }
    if (!options.keepBranch) {
      if (!worktree.branch) {
        throw new WaldError("Detached worktrees require --keep-branch to rename their directory.");
      }
      if (worktree.branch === workspace.config.defaultBranch) {
        throw new WaldError(
          "The configured default branch requires --keep-branch to rename its directory.",
        );
      }
    }
    const branch = options.keepBranch ? worktree.branch : (options.branch ?? newName);
    const renamed = branch !== worktree.branch;
    if (renamed) await this.assertExclusiveRenameBranch(workspace, worktree);
    if (branch !== null) {
      await this.validateRenameBranch(workspace, branch);
      if (renamed) await this.assertRenameBranchAvailable(workspace, branch);
    }
    const identity = await this.inspectMoveIdentity(workspace, worktree, cwd);
    return {
      worktree,
      target,
      cwd,
      worktreeRoot,
      ...identity,
      options: { ...options },
      branchChange: {
        before: worktree.branch,
        after: branch,
        renamed,
        upstream: identity.tracking.upstream,
      },
    };
  }

  async move(workspace: Workspace, plan: MoveWorktreePlan): Promise<Worktree> {
    // A prepared plan may be stale. Recheck every boundary before the first mutation.
    const current = await this.prepareMove(
      workspace,
      plan.worktree.path,
      path.basename(plan.target),
      plan.cwd,
      plan.options,
    );
    if (
      current.target !== plan.target ||
      current.worktreeRoot !== plan.worktreeRoot ||
      current.worktree.head !== plan.worktree.head ||
      current.worktree.branchRef !== plan.worktree.branchRef ||
      current.gitPath !== plan.gitPath ||
      current.directoryId !== plan.directoryId ||
      !sameTracking(current.tracking, plan.tracking) ||
      current.branchChange.after !== plan.branchChange.after ||
      current.branchChange.before !== plan.branchChange.before ||
      current.branchChange.renamed !== plan.branchChange.renamed
    ) {
      throw new WaldError("Worktree identity, HEAD, or upstream changed after rename preparation.");
    }

    try {
      if (plan.branchChange.renamed) {
        await this.renameLocalBranch(workspace, plan.branchChange.before, plan.branchChange.after);
      }
      await this.verifyMove(workspace, plan, plan.worktree.path, plan.branchChange.after);
      await this.verifyRenamedRef(workspace, plan, plan.worktree.path);
      if (await pathEntryExists(plan.target)) {
        throw new WaldError(`Worktree directory already exists: ${plan.target}`);
      }
      await this.git.run(["worktree", "move", plan.worktree.path, plan.target], {
        gitDir: workspace.gitDir,
      });
      const moved = await this.verifyMove(workspace, plan, plan.target, plan.branchChange.after);
      await this.verifyRenamedRef(workspace, plan, plan.target);
      if (await pathEntryExists(plan.worktree.path)) {
        throw new WaldError(`The original worktree path still exists: ${plan.worktree.path}`);
      }
      return moved;
    } catch (error) {
      try {
        await this.rollbackMove(workspace, plan);
      } catch (rollbackError) {
        throw new WaldError(
          `Rename failed: ${toErrorMessage(error)}\nRollback incomplete: ${toErrorMessage(rollbackError)}\n` +
            `Recovery: inspect git worktree list --porcelain and both paths (${plan.worktree.path}, ${plan.target}). ` +
            `Verify HEAD ${plan.worktree.head}, the worktree Git directory ${plan.gitPath}, and upstream ${plan.tracking.upstream ?? "none"}. ` +
            `If the matching worktree remains at ${plan.target}, use git worktree move to restore ${plan.worktree.path}. ` +
            (plan.branchChange.renamed
              ? `If its branch remains ${plan.branchChange.after}, verify ${plan.branchChange.before} is free, then use git branch --move to restore ${plan.branchChange.before}. `
              : "") +
            "Do not force, delete, or overwrite conflicting paths or refs.",
          { cause: error },
        );
      }
      throw new WaldError(
        `Rename failed; original worktree path and branch restored: ${toErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async renameLocalBranch(
    workspace: Workspace,
    before: string | null,
    after: string | null,
  ): Promise<void> {
    if (!before || !after) throw new WaldError("Cannot rename a detached HEAD.");
    await this.git.run(["branch", "--move", "--", before, after], { gitDir: workspace.gitDir });
  }

  private async verifyRenamedRef(
    workspace: Workspace,
    plan: MoveWorktreePlan,
    worktreePath: string,
  ): Promise<void> {
    if (
      plan.branchChange.renamed &&
      plan.branchChange.before &&
      (await this.refExists(workspace, `refs/heads/${plan.branchChange.before}`))
    ) {
      throw new WaldError(`Original branch still exists after rename: ${plan.branchChange.before}`);
    }
    if (plan.branchChange.renamed) {
      await this.assertExclusiveRenameBranch(workspace, {
        ...plan.worktree,
        path: worktreePath,
        branch: plan.branchChange.after,
        branchRef: `refs/heads/${plan.branchChange.after}`,
      });
    }
  }

  private async assertExclusiveRenameBranch(
    workspace: Workspace,
    worktree: Worktree,
  ): Promise<void> {
    if (
      (await this.list(workspace)).some(
        (candidate) =>
          candidate.path !== worktree.path && candidate.branchRef === worktree.branchRef,
      )
    ) {
      throw new WaldError(
        `Cannot rename a branch checked out in multiple worktrees: ${worktree.branch}`,
      );
    }
  }

  private async validateRenameBranch(workspace: Workspace, branch: string): Promise<void> {
    // Check the literal ref too: --branch alone expands shorthand such as @{-1}.
    await this.validateBranch(workspace, branch);
    if (
      !(await this.git.succeeds(["check-ref-format", `refs/heads/${branch}`], {
        gitDir: workspace.gitDir,
      }))
    ) {
      throw new WaldError(`Invalid branch name: ${branch}`);
    }
  }

  private async assertRenameBranchAvailable(workspace: Workspace, branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`;
    const refs = await this.git.run(["for-each-ref", "--format=%(refname)", "refs/heads/"], {
      gitDir: workspace.gitDir,
    });
    if (
      refs.stdout
        .split("\n")
        .some(
          (existing) =>
            existing === ref || existing.startsWith(`${ref}/`) || ref.startsWith(`${existing}/`),
        )
    ) {
      throw new WaldError(
        `Local branch already exists or conflicts with the requested name: ${branch}`,
      );
    }
    // Git moves the entire branch config section. Do not merge it with orphaned target settings.
    const escaped = branch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const config = await this.git.run(["config", "--get-regexp", `^branch\\.${escaped}\\.`], {
      gitDir: workspace.gitDir,
      reject: false,
    });
    if (config.exitCode !== 1) {
      throw new WaldError(
        `Cannot safely rename to a branch with existing or unreadable configuration: ${branch}`,
      );
    }
  }

  private async inspectMoveIdentity(
    workspace: Workspace,
    worktree: Worktree,
    cwd: string,
  ): Promise<{ gitPath: string; directoryId: string; tracking: BranchTracking }> {
    const listed = await this.list(workspace);
    const actual = listed.find((candidate) => candidate.path === worktree.path);
    const current = await this.currentFromList(listed, cwd);
    if (
      !actual ||
      actual.head !== worktree.head ||
      actual.branchRef !== worktree.branchRef ||
      !actual.head ||
      actual.role === "primary" ||
      actual.path === current?.path ||
      actual.locked ||
      actual.state === "missing" ||
      actual.state === "unavailable" ||
      (await canonicalPath(path.dirname(actual.path))) !==
        (await canonicalPath(workspace.worktreeDir)) ||
      (await canonicalPath(actual.path)) !== actual.path ||
      (await this.hasSubmodules(actual))
    ) {
      throw new WaldError(`Worktree identity or movable state changed: ${worktree.path}`);
    }
    const head = await this.git.run(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: actual.path,
    });
    const symbolic = await this.git.run(["symbolic-ref", "--quiet", "HEAD"], {
      cwd: actual.path,
      reject: false,
    });
    if (
      head.stdout !== worktree.head ||
      (worktree.branchRef
        ? symbolic.exitCode !== 0 || symbolic.stdout !== worktree.branchRef
        : symbolic.exitCode !== 1)
    ) {
      throw new WaldError(`Worktree HEAD or branch identity changed: ${worktree.path}`);
    }
    const gitPath = await this.git.run(["rev-parse", "--absolute-git-dir"], { cwd: actual.path });
    const common = await this.git.run(["rev-parse", "--git-common-dir"], { cwd: actual.path });
    if (
      (await canonicalPath(path.resolve(actual.path, common.stdout))) !==
      (await canonicalPath(workspace.gitDir))
    ) {
      throw new WaldError(`Worktree belongs to a different Git repository: ${actual.path}`);
    }
    if (worktree.branchRef) {
      if (worktree.branchRef !== `refs/heads/${worktree.branch}`) {
        throw new WaldError(`Branch identity is not a local branch: ${worktree.branch}`);
      }
      const ref = await this.git.run(["rev-parse", "--verify", worktree.branchRef], {
        gitDir: workspace.gitDir,
      });
      const alias = await this.git.run(["symbolic-ref", "--quiet", worktree.branchRef], {
        gitDir: workspace.gitDir,
        reject: false,
      });
      if (ref.stdout !== worktree.head || alias.exitCode !== 1) {
        throw new WaldError(`Local branch identity changed: ${worktree.branch}`);
      }
    }
    const directory = await fs.stat(actual.path);
    return {
      gitPath: await canonicalPath(gitPath.stdout),
      directoryId: `${directory.dev}:${directory.ino}`,
      tracking: await this.readBranchTracking(worktree.branch, actual.path),
    };
  }

  private async readBranchTracking(
    branch: string | null,
    worktreePath: string,
  ): Promise<BranchTracking> {
    if (branch === null) return { remote: "", merge: "", upstream: null, upstreamRef: null };
    const values: string[] = [];
    for (const key of ["remote", "merge"]) {
      const result = await this.git.run(
        ["config", "--null", "--get-all", `branch.${branch}.${key}`],
        {
          cwd: worktreePath,
          reject: false,
          stripFinalNewline: false,
        },
      );
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new WaldError(`Cannot read upstream configuration for branch: ${branch}`);
      }
      values.push(result.stdout);
    }
    const upstream = await this.git.run(
      ["for-each-ref", "--format=%(refname)%00%(upstream)", `refs/heads/${branch}`],
      { cwd: worktreePath },
    );
    const entry = upstream.stdout
      .split("\n")
      .find((line) => line.startsWith(`refs/heads/${branch}\0`));
    if (entry === undefined) throw new WaldError(`Cannot read upstream for branch: ${branch}`);
    return {
      remote: values[0] ?? "",
      merge: values[1] ?? "",
      upstream: entry.split("\0")[1]?.replace(/^refs\/(?:heads|remotes)\//u, "") || null,
      upstreamRef: entry.split("\0")[1] || null,
    };
  }

  private async verifyMove(
    workspace: Workspace,
    plan: MoveWorktreePlan,
    target: string,
    branch: string | null,
  ): Promise<Worktree> {
    if ((await canonicalPath(workspace.worktreeDir)) !== plan.worktreeRoot) {
      throw new WaldError("Configured worktree root changed during rename.");
    }
    const expected = {
      ...plan.worktree,
      path: target,
      branch,
      branchRef: branch === null ? null : `refs/heads/${branch}`,
    };
    const identity = await this.inspectMoveIdentity(workspace, expected, plan.cwd);
    if (
      identity.gitPath !== plan.gitPath ||
      identity.directoryId !== plan.directoryId ||
      !sameTracking(identity.tracking, plan.tracking)
    ) {
      throw new WaldError(`Worktree Git identity or upstream changed: ${target}`);
    }
    const actual = (await this.list(workspace)).find((candidate) => candidate.path === target);
    if (!actual || actual.head !== expected.head || actual.branchRef !== expected.branchRef) {
      throw new WaldError(`Worktree identity changed: ${target}`);
    }
    return actual;
  }

  private async rollbackMove(workspace: Workspace, plan: MoveWorktreePlan): Promise<void> {
    const locate = async () => {
      const candidates = (await this.list(workspace)).filter(
        (candidate) => candidate.path === plan.worktree.path || candidate.path === plan.target,
      );
      const matching: Worktree[] = [];
      for (const candidate of candidates) {
        if (
          candidate.branch !== plan.branchChange.before &&
          candidate.branch !== plan.branchChange.after
        )
          continue;
        const gitPath = await this.git.run(["rev-parse", "--absolute-git-dir"], {
          cwd: candidate.path,
          reject: false,
        });
        if (gitPath.exitCode === 0 && (await canonicalPath(gitPath.stdout)) === plan.gitPath)
          matching.push(candidate);
      }
      const candidate = matching[0];
      if (matching.length !== 1 || !candidate)
        throw new WaldError("Cannot uniquely identify the worktree for rollback.");
      return await this.verifyMove(workspace, plan, candidate.path, candidate.branch);
    };
    const failures: string[] = [];
    try {
      const actual = await locate();
      if (actual.path !== plan.worktree.path) {
        if (
          (await pathEntryExists(plan.worktree.path)) ||
          (await this.list(workspace)).some((candidate) => candidate.path === plan.worktree.path)
        ) {
          throw new WaldError(`Original path is occupied: ${plan.worktree.path}`);
        }
        await this.git.run(["worktree", "move", actual.path, plan.worktree.path], {
          gitDir: workspace.gitDir,
        });
      }
    } catch (error) {
      failures.push(toErrorMessage(error));
    }
    try {
      const actual = await locate();
      if (plan.branchChange.renamed && actual.branch === plan.branchChange.after) {
        if (!plan.branchChange.before) throw new WaldError("Original branch is unavailable.");
        await this.assertExclusiveRenameBranch(workspace, actual);
        await this.assertRenameBranchAvailable(workspace, plan.branchChange.before);
        await this.renameLocalBranch(workspace, actual.branch, plan.branchChange.before);
      }
    } catch (error) {
      failures.push(toErrorMessage(error));
    }
    try {
      await this.verifyMove(workspace, plan, plan.worktree.path, plan.branchChange.before);
    } catch (error) {
      failures.push(toErrorMessage(error));
    }
    if (
      plan.branchChange.renamed &&
      plan.branchChange.after &&
      (await this.refExists(workspace, `refs/heads/${plan.branchChange.after}`))
    ) {
      failures.push(`The target branch still exists: ${plan.branchChange.after}`);
    }
    if (failures.length > 0) throw new WaldError(failures.join("; "));
  }

  async rollbackCreated(
    workspace: Workspace,
    worktree: Worktree,
    expectedHead: string,
  ): Promise<void> {
    const current = (await this.list(workspace)).find(
      (candidate) => candidate.path === worktree.path,
    );
    if (
      !current ||
      current.head !== expectedHead ||
      current.branchRef !== worktree.branchRef ||
      !current.branchRef ||
      current.locked ||
      current.state !== "clean"
    ) {
      throw new WaldError(
        `Refusing to roll back a created worktree whose Git identity changed: ${worktree.path}`,
      );
    }
    await this.git.run(["worktree", "remove", "--force", current.path], {
      gitDir: workspace.gitDir,
    });
    await this.git.run(["update-ref", "-d", current.branchRef, expectedHead], {
      gitDir: workspace.gitDir,
    });
  }

  private async validateBranch(workspace: Workspace, branch: string): Promise<void> {
    const valid = await this.git.succeeds(["check-ref-format", "--branch", branch], {
      gitDir: workspace.gitDir,
    });
    if (!valid) {
      throw new WaldError(`Invalid branch name: ${branch}`);
    }
  }

  private async resolveBase(workspace: Workspace, requestedBase?: string): Promise<string> {
    if (requestedBase) {
      if (!(await this.commitExists(workspace, requestedBase))) {
        throw new WaldError(`Base does not resolve to a commit: ${requestedBase}`);
      }
      return requestedBase;
    }

    const remote = workspace.config.remote;
    if (remote) {
      const remoteDefault = `${remote.name}/${workspace.config.defaultBranch}`;
      if (await this.commitExists(workspace, remoteDefault)) {
        return remoteDefault;
      }
    }
    if (await this.commitExists(workspace, workspace.config.defaultBranch)) {
      return workspace.config.defaultBranch;
    }
    throw new WaldError(
      `Default branch does not resolve to a commit: ${workspace.config.defaultBranch}`,
    );
  }

  private async commitExists(workspace: Workspace, reference: string): Promise<boolean> {
    return await this.git.succeeds(["rev-parse", "--verify", "--quiet", `${reference}^{commit}`], {
      gitDir: workspace.gitDir,
    });
  }

  private async refExists(workspace: Workspace, reference: string): Promise<boolean> {
    return await this.git.succeeds(["show-ref", "--verify", "--quiet", reference], {
      gitDir: workspace.gitDir,
    });
  }

  private async hasSubmodules(worktree: Worktree): Promise<boolean> {
    const result = await this.git.run(["ls-files", "--stage", "-z"], {
      cwd: worktree.path,
      reject: false,
    });
    return (
      result.exitCode === 0 &&
      result.stdout.split("\0").some((entry) => entry.startsWith("160000 "))
    );
  }

  private async readState(worktree: ParsedWorktree): Promise<WorktreeState> {
    if (!(await pathExists(worktree.path))) {
      return "missing";
    }
    if (worktree.locked) {
      return "locked";
    }

    const status = await this.git.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
      { cwd: worktree.path, reject: false },
    );
    if (status.exitCode !== 0) {
      return "unavailable";
    }
    return status.stdout.length > 0 ? "modified" : "clean";
  }

  private async isMergedIntoDefault(workspace: Workspace, worktree: Worktree): Promise<boolean> {
    if (!worktree.branchRef) {
      return false;
    }

    return await this.isBranchMergedIntoDefault(workspace, worktree.branchRef);
  }

  private inspectBranchDeletion(
    workspace: Workspace,
    worktree: Worktree,
    merged: boolean,
  ): BranchDeletionInspection {
    if (!worktree.branch || !worktree.branchRef) {
      return {
        eligible: false,
        branch: null,
        reason: "the worktree is not on a local branch",
      };
    }
    if (worktree.branch === workspace.config.defaultBranch) {
      return {
        eligible: false,
        branch: worktree.branch,
        reason: "the configured default branch is never deleted",
      };
    }
    if (!worktree.head) {
      return {
        eligible: false,
        branch: worktree.branch,
        reason: "the branch HEAD could not be determined",
      };
    }
    return {
      eligible: true,
      branch: worktree.branch,
      branchRef: worktree.branchRef,
      expectedHead: worktree.head,
      mergedIntoDefault: merged,
    };
  }

  private async isBranchMergedIntoDefault(
    workspace: Workspace,
    branchRef: string,
  ): Promise<boolean> {
    const remote = workspace.config.remote;
    const remoteDefault = remote
      ? `${remote.name}/${workspace.config.defaultBranch}`
      : workspace.config.defaultBranch;
    const defaultReference =
      remote && (await this.commitExists(workspace, remoteDefault))
        ? remoteDefault
        : workspace.config.defaultBranch;
    return await this.git.succeeds(["merge-base", "--is-ancestor", branchRef, defaultReference], {
      gitDir: workspace.gitDir,
    });
  }
}

function sameTracking(left: BranchTracking, right: BranchTracking): boolean {
  return (
    left.remote === right.remote &&
    left.merge === right.merge &&
    left.upstreamRef === right.upstreamRef
  );
}

export function slugifyBranch(branch: string): string {
  const slug = branch
    .replace(/[\\/]+/gu, "-")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");

  if (!slug) {
    throw new WaldError(`Could not derive a directory name from branch: ${branch}`);
  }
  return slug;
}

export function validateWorktreeName(name: string): void {
  if (
    name.length === 0 ||
    name.trim() !== name ||
    name === "." ||
    name === ".." ||
    name === ".wald" ||
    name === "repo.git" ||
    path.isAbsolute(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    hasControlCharacters(name)
  ) {
    throw new WaldError(`Invalid worktree directory name: ${name}`);
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

export function parseWorktreePorcelain(output: string): ParsedWorktree[] {
  const nulDelimited = output.includes("\0");
  const records = nulDelimited
    ? output.split("\0\0").filter(Boolean)
    : output.split(/\r?\n\r?\n/u).filter(Boolean);
  return records.map((record) => {
    let worktreePath: string | null = null;
    let head: string | null = null;
    let branchRef: string | null = null;
    let locked = false;
    let lockReason: string | null = null;
    let prunable = false;
    let bare = false;

    const fields = nulDelimited ? record.split("\0") : record.split(/\r?\n/u);
    for (const field of fields.filter(Boolean)) {
      const [key, ...rest] = field.split(" ");
      const value = rest.join(" ") || null;
      switch (key) {
        case "worktree":
          worktreePath = value ? decodeGitPath(value) : null;
          break;
        case "HEAD":
          head = value;
          break;
        case "branch":
          branchRef = value;
          break;
        case "locked":
          locked = true;
          lockReason = value;
          break;
        case "prunable":
          prunable = true;
          break;
        case "bare":
          bare = true;
          break;
      }
    }

    if (!worktreePath) {
      throw new WaldError("Git returned a worktree record without a path.");
    }

    return {
      path: worktreePath,
      head,
      branchRef,
      branch: branchRef?.replace(/^refs\/heads\//u, "") ?? null,
      locked,
      lockReason,
      prunable,
      bare,
    };
  });
}

export async function listWorktreePorcelain(
  git: GitClient,
  gitDir: string,
  options: ListWorktreeOptions = {},
): Promise<ParsedWorktree[]> {
  const args = ["worktree", "list", "--porcelain"];
  if (options.expire) args.push("--expire", options.expire);

  const nulResult = await git.run([...args, "-z"], { gitDir, reject: false });
  if (nulResult.exitCode === 0) return parseWorktreePorcelain(nulResult.stdout);

  const legacyResult = await git.run(args, { gitDir });
  return parseWorktreePorcelain(legacyResult.stdout);
}

function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;

  const bytes: number[] = [];
  const escaped = value.slice(1, -1);
  const escapeBytes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    "\\": 0x5c,
  };

  for (let index = 0; index < escaped.length; index += 1) {
    const character = escaped[index];
    if (character === "\\") {
      const escapedCharacter = escaped[index + 1];
      if (escapedCharacter === undefined) break;
      const octal = escaped.slice(index + 1).match(/^[0-7]{1,3}/u)?.[0];
      if (octal) {
        bytes.push(Number.parseInt(octal, 8));
        index += octal.length;
        continue;
      }
      bytes.push(escapeBytes[escapedCharacter] ?? escapedCharacter.charCodeAt(0));
      index += 1;
      continue;
    }

    const codePoint = escaped.codePointAt(index);
    if (codePoint === undefined) break;
    const plainCharacter = String.fromCodePoint(codePoint);
    bytes.push(...Buffer.from(plainCharacter));
    index += plainCharacter.length - 1;
  }

  return Buffer.from(bytes).toString("utf8");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function pathEntryExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function findPortableNameCollision(
  parent: string,
  requestedName: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const normalized = requestedName.normalize("NFC").toLocaleLowerCase("en-US");
  return (
    entries.find(
      (entry) =>
        entry !== requestedName && entry.normalize("NFC").toLocaleLowerCase("en-US") === normalized,
    ) ?? null
  );
}

async function canonicalPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return path.resolve(target);
    }
    throw error;
  }
}
