import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { YggError } from "../domain/errors.js";
import type { GitClient } from "../infrastructure/git-client.js";
import { isPathInside } from "../infrastructure/path-utils.js";

type UntrackedFile = {
  path: string;
  type: "file";
  mode: number;
  content: Buffer;
  hash: string;
};

type UntrackedSymlink = {
  path: string;
  type: "symlink";
  mode: number;
  target: string;
  hash: string;
};

type UntrackedEntry = UntrackedFile | UntrackedSymlink;

export type WorktreeTransferSummary = {
  staged: number;
  unstaged: number;
  untracked: number;
};

export type WorktreeTransferSnapshot = {
  sourcePath: string;
  head: string;
  stagedPatch: string;
  unstagedPatch: string;
  untracked: UntrackedEntry[];
  summary: WorktreeTransferSummary;
  fingerprint: string;
};

export class WorktreeTransferError extends YggError {
  readonly rollbackSafe: boolean;

  constructor(message: string, options: { cause?: unknown; rollbackSafe: boolean }) {
    super(message, { cause: options.cause });
    this.name = "WorktreeTransferError";
    this.rollbackSafe = options.rollbackSafe;
  }
}

export class WorktreeTransferService {
  constructor(private readonly git: GitClient) {}

  async capture(sourcePath: string): Promise<WorktreeTransferSnapshot> {
    await this.validateSourceState(sourcePath);
    const head = (
      await this.git.run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: sourcePath })
    ).stdout;
    const [stagedPatch, unstagedPatch, stagedPaths, unstagedPaths, untrackedPaths] =
      await Promise.all([
        this.readPatch(sourcePath, true),
        this.readPatch(sourcePath, false),
        this.readChangedPaths(sourcePath, true),
        this.readChangedPaths(sourcePath, false),
        this.readUntrackedPaths(sourcePath),
      ]);
    const untracked = await Promise.all(
      untrackedPaths.map(
        async (relativePath) => await this.captureUntracked(sourcePath, relativePath),
      ),
    );
    const summary = {
      staged: stagedPaths.length,
      unstaged: unstagedPaths.length,
      untracked: untracked.length,
    };
    return {
      sourcePath,
      head,
      stagedPatch,
      unstagedPatch,
      untracked,
      summary,
      fingerprint: fingerprint(head, stagedPatch, unstagedPatch, untracked),
    };
  }

  async apply(snapshot: WorktreeTransferSnapshot, targetPath: string): Promise<void> {
    let rollbackSafe = false;
    try {
      const targetHead = (
        await this.git.run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: targetPath })
      ).stdout;
      if (targetHead !== snapshot.head) {
        throw new YggError(
          `Carry target must start at ${snapshot.head}, but ${targetPath} is at ${targetHead}.`,
        );
      }
      const targetStatus = await this.git.run(
        ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        { cwd: targetPath },
      );
      if (targetStatus.stdout.length > 0) {
        throw new YggError(`Carry target is not clean: ${targetPath}`);
      }
      rollbackSafe = true;

      if (snapshot.stagedPatch) {
        await this.applyPatch(targetPath, snapshot.stagedPatch, true, true);
        rollbackSafe = false;
        await this.applyPatch(targetPath, snapshot.stagedPatch, true, false);
      }
      if (snapshot.unstagedPatch) {
        await this.applyPatch(targetPath, snapshot.unstagedPatch, false, true);
        rollbackSafe = false;
        await this.applyPatch(targetPath, snapshot.unstagedPatch, false, false);
      }
      for (const entry of snapshot.untracked) {
        rollbackSafe = false;
        await this.restoreUntracked(targetPath, entry);
      }

      const [sourceAfter, targetAfter] = await Promise.all([
        this.capture(snapshot.sourcePath),
        this.capture(targetPath),
      ]);
      if (sourceAfter.fingerprint !== snapshot.fingerprint) {
        throw new YggError(
          `The source worktree changed while its local changes were being carried: ${snapshot.sourcePath}`,
        );
      }
      if (targetAfter.fingerprint !== snapshot.fingerprint) {
        throw new YggError(`Carried worktree state could not be verified at ${targetPath}`);
      }
    } catch (error) {
      if (error instanceof WorktreeTransferError) throw error;
      throw new WorktreeTransferError(toTransferErrorMessage(error), {
        cause: error,
        rollbackSafe,
      });
    }
  }

  private async validateSourceState(sourcePath: string): Promise<void> {
    const sparse = await this.git.run(["config", "--bool", "core.sparseCheckout"], {
      cwd: sourcePath,
      reject: false,
    });
    if (sparse.exitCode === 0 && sparse.stdout === "true") {
      throw new YggError("Carrying changes from a sparse checkout is not supported.");
    }

    const unmerged = await this.git.run(["ls-files", "--unmerged", "-z"], { cwd: sourcePath });
    if (unmerged.stdout.length > 0) {
      throw new YggError("Resolve unmerged files before carrying worktree changes.");
    }
    await this.rejectActiveOperation(sourcePath);

    const [stagedRaw, unstagedRaw, status] = await Promise.all([
      this.git.run(["diff", "--raw", "--cached", "--ignore-submodules=none"], {
        cwd: sourcePath,
      }),
      this.git.run(["diff", "--raw", "--ignore-submodules=none"], { cwd: sourcePath }),
      this.git.run(
        ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"],
        { cwd: sourcePath },
      ),
    ]);
    if (
      stagedRaw.stdout.includes("160000") ||
      unstagedRaw.stdout.includes("160000") ||
      status.stdout.split("\0").some((entry) => /^[12] [^ ]+ S/u.test(entry))
    ) {
      throw new YggError("Commit or discard submodule changes before carrying worktree changes.");
    }
  }

  private async rejectActiveOperation(sourcePath: string): Promise<void> {
    const operationPaths = [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-apply",
      "rebase-merge",
      "sequencer",
      "BISECT_LOG",
    ];
    for (const operationPath of operationPaths) {
      const result = await this.git.run(["rev-parse", "--git-path", operationPath], {
        cwd: sourcePath,
      });
      const resolved = path.resolve(sourcePath, result.stdout);
      if (await pathEntryExists(resolved)) {
        throw new YggError(
          `Finish the active Git operation (${operationPath}) before carrying worktree changes.`,
        );
      }
    }
  }

  private async readPatch(sourcePath: string, cached: boolean): Promise<string> {
    const args = [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-color",
      "--ita-visible-in-index",
    ];
    if (cached) args.push("--cached");
    return (
      await this.git.run(args, {
        cwd: sourcePath,
        stripFinalNewline: false,
      })
    ).stdout;
  }

  private async readChangedPaths(sourcePath: string, cached: boolean): Promise<string[]> {
    const args = ["diff", "--name-only", "-z", "--ita-visible-in-index"];
    if (cached) args.push("--cached");
    const result = await this.git.run(args, { cwd: sourcePath, stripFinalNewline: false });
    return splitNull(result.stdout);
  }

  private async readUntrackedPaths(sourcePath: string): Promise<string[]> {
    const result = await this.git.run(["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: sourcePath,
      stripFinalNewline: false,
    });
    return splitNull(result.stdout).sort((left, right) => left.localeCompare(right));
  }

  private async captureUntracked(root: string, relativePath: string): Promise<UntrackedEntry> {
    const source = resolveTransferPath(root, relativePath);
    const stat = await fs.lstat(source);
    const mode = stat.mode & 0o777;
    if (stat.isFile()) {
      const content = await fs.readFile(source);
      return {
        path: relativePath,
        type: "file",
        mode,
        content,
        hash: createHash("sha256").update(content).digest("hex"),
      };
    }
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(source);
      return {
        path: relativePath,
        type: "symlink",
        mode,
        target,
        hash: createHash("sha256").update(target).digest("hex"),
      };
    }
    throw new YggError(`Cannot carry non-file untracked entry: ${relativePath}`);
  }

  private async applyPatch(
    targetPath: string,
    patch: string,
    index: boolean,
    check: boolean,
  ): Promise<void> {
    const args = ["apply", "--binary", "--whitespace=nowarn"];
    if (index) args.push("--index");
    if (check) args.push("--check");
    args.push("-");
    await this.git.run(args, { cwd: targetPath, input: patch });
  }

  private async restoreUntracked(targetRoot: string, entry: UntrackedEntry): Promise<void> {
    const target = resolveTransferPath(targetRoot, entry.path);
    if (await pathEntryExists(target)) {
      throw new YggError(`Carry target already exists: ${entry.path}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (entry.type === "symlink") {
      await fs.symlink(entry.target, target);
      return;
    }
    await fs.writeFile(target, entry.content, { mode: entry.mode, flag: "wx" });
    await fs.chmod(target, entry.mode);
  }
}

function fingerprint(
  head: string,
  stagedPatch: string,
  unstagedPatch: string,
  untracked: UntrackedEntry[],
): string {
  const hash = createHash("sha256");
  hash.update(head);
  hash.update("\0staged\0");
  hash.update(stagedPatch);
  hash.update("\0unstaged\0");
  hash.update(unstagedPatch);
  for (const entry of untracked) {
    hash.update(`\0${entry.path}\0${entry.type}\0${entry.mode.toString(8)}\0${entry.hash}`);
  }
  return hash.digest("hex");
}

function splitNull(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function resolveTransferPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new YggError(`Invalid transfer path: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!isPathInside(root, resolved)) {
    throw new YggError(`Transfer path escapes its worktree: ${relativePath}`);
  }
  return resolved;
}

async function pathEntryExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function toTransferErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
