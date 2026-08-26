import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WtError } from "../domain/errors.js";
import type {
  EnvironmentFileStatus,
  EnvironmentImportCandidate,
  EnvironmentImportResult,
  EnvironmentSyncResult,
  Workspace,
  Worktree,
} from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";
import { isPathInside } from "../infrastructure/path-utils.js";

const excludedDirectoryNames = new Set([
  ".git",
  ".pnpm",
  "build",
  "coverage",
  "dist",
  "fixture",
  "fixtures",
  "node_modules",
]);
const excludedFileSuffixes = [".example", ".sample", ".template"];

export class EnvironmentService {
  constructor(private readonly git: GitClient) {}

  async status(workspace: Workspace, worktree: Worktree): Promise<EnvironmentFileStatus[]> {
    const sharedFiles = await this.listSharedFiles(workspace.envDir);
    return await Promise.all(
      sharedFiles.map(async (relativePath) => {
        const source = path.join(workspace.envDir, relativePath);
        const target = path.join(worktree.path, relativePath);
        return {
          path: relativePath,
          state: await this.readTargetState(source, target),
          target,
        };
      }),
    );
  }

  async sync(
    workspace: Workspace,
    worktree: Worktree,
    options: { repair?: boolean } = {},
  ): Promise<EnvironmentSyncResult> {
    this.assertAvailableWorktree(worktree);
    const statuses = await this.status(workspace, worktree);
    const result: EnvironmentSyncResult = {
      worktree,
      created: [],
      repaired: [],
      linked: [],
      conflicts: [],
    };

    for (const status of statuses) {
      const source = path.join(workspace.envDir, status.path);
      if (status.state === "linked") {
        result.linked.push(status.path);
        continue;
      }
      if (status.state === "conflict" || (status.state === "wrong-link" && !options.repair)) {
        result.conflicts.push(status);
        continue;
      }

      await fs.mkdir(path.dirname(status.target), { mode: 0o700, recursive: true });
      if (status.state === "wrong-link") {
        await fs.unlink(status.target);
      }
      await fs.symlink(path.relative(path.dirname(status.target), source), status.target);

      if (status.state === "wrong-link") {
        result.repaired.push(status.path);
      } else {
        result.created.push(status.path);
      }
    }

    return result;
  }

  async discoverImportCandidates(
    workspace: Workspace,
    worktree: Worktree,
  ): Promise<EnvironmentImportCandidate[]> {
    this.assertAvailableWorktree(worktree);
    const gitResult = await this.git.run(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        ".env",
        ".env.*",
        ":(glob)**/.env",
        ":(glob)**/.env.*",
      ],
      { cwd: worktree.path },
    );

    const relativePaths = gitResult.stdout
      .split("\0")
      .filter(Boolean)
      .filter(isImportableEnvironmentPath)
      .sort((left, right) => left.localeCompare(right));

    return await Promise.all(
      relativePaths.map(async (relativePath) => {
        const source = path.resolve(worktree.path, relativePath);
        const target = path.resolve(workspace.envDir, relativePath);
        this.assertManagedPath(worktree.path, source, "Environment source");
        this.assertManagedPath(workspace.envDir, target, "Environment target");

        const sourceState = await this.readTargetState(target, source);
        if (sourceState === "linked") {
          return { path: relativePath, source, target, state: "already-linked" as const };
        }
        if (sourceState === "wrong-link") {
          return { path: relativePath, source, target, state: "conflict" as const };
        }

        const targetStat = await lstatOrNull(target);
        if (!targetStat) {
          return { path: relativePath, source, target, state: "new" as const };
        }
        if (!targetStat.isFile()) {
          return { path: relativePath, source, target, state: "conflict" as const };
        }

        const sourceStat = await lstatOrNull(source);
        if (!sourceStat?.isFile()) {
          return { path: relativePath, source, target, state: "conflict" as const };
        }
        const same = await filesEqual(source, target);
        return { path: relativePath, source, target, state: same ? "same" : "conflict" };
      }),
    );
  }

  async importFiles(
    workspace: Workspace,
    worktree: Worktree,
    candidates: EnvironmentImportCandidate[],
  ): Promise<EnvironmentImportResult> {
    this.assertAvailableWorktree(worktree);
    await fs.mkdir(workspace.envDir, { mode: 0o700, recursive: true });
    await fs.chmod(workspace.envDir, 0o700);

    const result: EnvironmentImportResult = {
      worktree,
      imported: [],
      linked: [],
      skipped: [],
      conflicts: [],
    };

    for (const candidate of candidates) {
      this.assertManagedPath(worktree.path, candidate.source, "Environment source");
      this.assertManagedPath(workspace.envDir, candidate.target, "Environment target");

      if (candidate.state === "conflict") {
        result.conflicts.push(candidate.path);
        continue;
      }
      if (candidate.state === "already-linked") {
        result.skipped.push(candidate.path);
        continue;
      }

      if (candidate.state === "new") {
        await this.copyAtomically(candidate.source, candidate.target);
        result.imported.push(candidate.path);
      }

      await this.replaceWithSymlink(candidate.source, candidate.target);
      result.linked.push(candidate.path);
    }

    return result;
  }

  private async listSharedFiles(root: string): Promise<string[]> {
    if (!(await lstatOrNull(root))) {
      return [];
    }

    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath);
        } else if (entry.isFile()) {
          files.push(path.relative(root, absolutePath));
        }
      }
    };

    await walk(root);
    return files.sort((left, right) => left.localeCompare(right));
  }

  private async readTargetState(
    source: string,
    target: string,
  ): Promise<EnvironmentFileStatus["state"]> {
    const targetStat = await lstatOrNull(target);
    if (!targetStat) {
      return "missing";
    }
    if (!targetStat.isSymbolicLink()) {
      return "conflict";
    }

    const link = await fs.readlink(target);
    const resolvedLink = path.resolve(path.dirname(target), link);
    return resolvedLink === path.resolve(source) ? "linked" : "wrong-link";
  }

  private async copyAtomically(source: string, target: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { mode: 0o700, recursive: true });
    const temporaryTarget = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${randomUUID()}.tmp`,
    );
    try {
      await fs.copyFile(source, temporaryTarget, fs.constants.COPYFILE_EXCL);
      await fs.chmod(temporaryTarget, 0o600);
      await fs.rename(temporaryTarget, target);
    } finally {
      await fs.rm(temporaryTarget, { force: true });
    }
  }

  private async replaceWithSymlink(source: string, target: string): Promise<void> {
    const temporaryLink = path.join(
      path.dirname(source),
      `.${path.basename(source)}.${randomUUID()}.link`,
    );
    try {
      await fs.symlink(path.relative(path.dirname(source), target), temporaryLink);
      await fs.rename(temporaryLink, source);
    } finally {
      await fs.rm(temporaryLink, { force: true });
    }
  }

  private assertManagedPath(parent: string, candidate: string, label: string): void {
    if (!isPathInside(parent, candidate)) {
      throw new WtError(`${label} must stay inside its managed root.`);
    }
  }

  private assertAvailableWorktree(worktree: Worktree): void {
    if (worktree.state === "missing") {
      throw new WtError(`Worktree path is missing: ${worktree.path}`);
    }
  }
}

export function isImportableEnvironmentPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => excludedDirectoryNames.has(segment))) {
    return false;
  }

  const fileName = segments.at(-1) ?? "";
  if (fileName !== ".env" && !fileName.startsWith(".env.")) {
    return false;
  }
  return !excludedFileSuffixes.some((suffix) => fileName.endsWith(suffix));
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  const [leftContent, rightContent] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return leftContent.equals(rightContent);
}
