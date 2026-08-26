import fs from "node:fs/promises";
import path from "node:path";
import { WtError } from "../domain/errors.js";
import type { Workspace, Worktree, WorktreeState } from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";
import { isPathInside } from "../infrastructure/path-utils.js";

export type ParsedWorktree = Omit<Worktree, "name" | "role" | "state"> & { bare: boolean };

export type AddWorktreeOptions = {
  branch: string;
  from?: string;
  name?: string;
  fetch?: boolean;
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

export type RemovalInspection = {
  worktree: Worktree;
  dirty: boolean;
  merged: boolean;
  blockers: string[];
  hardBlockers: string[];
};

export class WorktreeService {
  constructor(private readonly git: GitClient) {}

  async list(workspace: Workspace): Promise<Worktree[]> {
    const result = await this.git.run(["worktree", "list", "--porcelain", "-z"], {
      gitDir: workspace.gitDir,
    });
    const parsed = parseWorktreePorcelain(result.stdout).filter((worktree) => !worktree.bare);

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
      throw new WtError("Worktree directory must stay inside the configured worktree root.");
    }
    if (target === workspace.gitDir) {
      throw new WtError(`Reserved worktree directory: ${directoryName}`);
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
      throw new WtError(
        `Branch ${options.branch} is already checked out at ${existingCheckout.path}`,
      );
    }
    if (await pathExists(target)) {
      throw new WtError(
        `Worktree directory already exists: ${target}. Choose another directory with --name <directory>.`,
      );
    }

    const localExists = await this.refExists(workspace, branchRef);
    const remoteExists = remoteRef ? await this.refExists(workspace, remoteRef) : false;

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
        ["worktree", "add", "-b", prepared.branch, prepared.target, prepared.strategy.base],
        { gitDir: workspace.gitDir },
      );
    }

    const created = (await this.list(workspace)).find(
      (worktree) => worktree.branchRef === prepared.branchRef,
    );
    if (!created) {
      throw new WtError(
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
    const resolvedIdentifier = await canonicalPath(path.resolve(workspace.root, identifier));
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
      throw new WtError(`No managed worktree matches: ${identifier}`);
    }
    if (matches.length > 1) {
      throw new WtError(`Worktree identifier is ambiguous: ${identifier}`);
    }
    return matches[0] as Worktree;
  }

  async current(workspace: Workspace, cwd = process.cwd()): Promise<Worktree | null> {
    const currentPath = await canonicalPath(cwd);
    const worktrees = await this.list(workspace);
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
      hardBlockers.push("the primary checkout cannot be removed by wt");
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

    return { worktree, dirty, merged, blockers, hardBlockers };
  }

  async remove(workspace: Workspace, worktree: Worktree, force: boolean): Promise<void> {
    if (worktree.role === "primary") {
      throw new WtError(`Refusing to remove the primary checkout: ${worktree.path}`);
    }
    const args = ["worktree", "remove"];
    if (force) {
      args.push("--force", "--force");
    }
    args.push(worktree.path);
    await this.git.run(args, { gitDir: workspace.gitDir });
  }

  private async validateBranch(workspace: Workspace, branch: string): Promise<void> {
    const valid = await this.git.succeeds(["check-ref-format", "--branch", branch], {
      gitDir: workspace.gitDir,
    });
    if (!valid) {
      throw new WtError(`Invalid branch name: ${branch}`);
    }
  }

  private async resolveBase(workspace: Workspace, requestedBase?: string): Promise<string> {
    if (requestedBase) {
      if (!(await this.commitExists(workspace, requestedBase))) {
        throw new WtError(`Base does not resolve to a commit: ${requestedBase}`);
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
    throw new WtError(
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
      return "missing";
    }
    return status.stdout.length > 0 ? "modified" : "clean";
  }

  private async isMergedIntoDefault(workspace: Workspace, worktree: Worktree): Promise<boolean> {
    if (!worktree.branchRef) {
      return false;
    }

    const remote = workspace.config.remote;
    const remoteDefault = remote
      ? `${remote.name}/${workspace.config.defaultBranch}`
      : workspace.config.defaultBranch;
    const defaultReference =
      remote && (await this.commitExists(workspace, remoteDefault))
        ? remoteDefault
        : workspace.config.defaultBranch;
    return await this.git.succeeds(
      ["merge-base", "--is-ancestor", worktree.branchRef, defaultReference],
      { gitDir: workspace.gitDir },
    );
  }
}

export function slugifyBranch(branch: string): string {
  const slug = branch
    .replace(/[\\/]+/gu, "-")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");

  if (!slug) {
    throw new WtError(`Could not derive a directory name from branch: ${branch}`);
  }
  return slug;
}

export function validateWorktreeName(name: string): void {
  if (
    name.length === 0 ||
    name.trim() !== name ||
    name === "." ||
    name === ".." ||
    name === ".wt" ||
    name === "repo.git" ||
    path.isAbsolute(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    hasControlCharacters(name)
  ) {
    throw new WtError(`Invalid worktree directory name: ${name}`);
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

export function parseWorktreePorcelain(output: string): ParsedWorktree[] {
  const records = output.split("\0\0").filter(Boolean);
  return records.map((record) => {
    let worktreePath: string | null = null;
    let head: string | null = null;
    let branchRef: string | null = null;
    let locked = false;
    let lockReason: string | null = null;
    let prunable = false;
    let bare = false;

    for (const field of record.split("\0").filter(Boolean)) {
      const [key, ...rest] = field.split(" ");
      const value = rest.join(" ") || null;
      switch (key) {
        case "worktree":
          worktreePath = value;
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
      throw new WtError("Git returned a worktree record without a path.");
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
