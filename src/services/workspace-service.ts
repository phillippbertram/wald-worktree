import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WtError } from "../domain/errors.js";
import type { Workspace, WorkspaceConfig, WorkspaceRemote, Worktree } from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";
import { humanizeRepositoryName, isPathInsideOrEqual } from "../infrastructure/path-utils.js";
import { type ParsedWorktree, parseWorktreePorcelain } from "./worktree-service.js";

const legacyWorkspaceConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    gitDir: z.string().min(1),
    envDir: z.string().min(1),
    remote: z.string().min(1),
    defaultBranch: z.string().min(1),
  })
  .strict();

const workspaceRemoteSchema = z
  .object({
    name: z.string().min(1),
    fetchRefspec: z.string().min(1),
  })
  .strict();

const workspaceConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    mode: z.enum(["managed", "adopted"]),
    gitDir: z.string().min(1),
    envDir: z.string().min(1),
    worktreeDir: z.string().min(1),
    remote: workspaceRemoteSchema.nullable(),
    defaultBranch: z.string().min(1),
    primaryWorktree: z.string().min(1).nullable(),
  })
  .strict();

type LegacyWorkspaceConfig = z.infer<typeof legacyWorkspaceConfigSchema>;

export type AdoptionOptions = {
  worktreeDir?: string;
  remote?: string | null;
  defaultBranch?: string;
};

export type AdoptionWorktree = Pick<
  Worktree,
  "path" | "branch" | "branchRef" | "locked" | "lockReason" | "prunable"
> & {
  bare: boolean;
};

export type AdoptionInspection = {
  source: string;
  gitDir: string;
  bare: boolean;
  primaryWorktree: string | null;
  worktrees: AdoptionWorktree[];
  remotes: string[];
  remoteName: string | null;
  remoteSelectionRequired: boolean;
  defaultBranch: string | null;
  defaultBranchCandidates: string[];
  worktreeDir: string;
  worktreeDirSelectionRequired: boolean;
  metadataDir: string;
  existingWorkspace: Workspace | null;
};

export class WorkspaceService {
  constructor(private readonly git: GitClient) {}

  async initialize(
    repository: string,
    directory?: string,
    startDirectory = process.cwd(),
  ): Promise<Workspace> {
    const root = path.resolve(startDirectory, directory ?? humanizeRepositoryName(repository));
    const gitDir = path.join(root, "repo.git");
    const metadataDir = path.join(root, ".wt");
    const envDir = path.join(metadataDir, "env");
    const configPath = path.join(metadataDir, "config.json");
    const rootExisted = await this.pathExists(root);

    if (rootExisted) {
      const entries = await fs.readdir(root);
      if (entries.length > 0) {
        throw new WtError(`Target directory is not empty: ${root}`);
      }
    } else {
      await fs.mkdir(root, { recursive: true });
    }

    try {
      await fs.mkdir(metadataDir, { mode: 0o700 });
      await fs.mkdir(envDir, { mode: 0o700 });
      await this.git.run(["clone", "--bare", "--", repository, gitDir], {
        cwd: startDirectory,
      });
      const remote = createRemote("origin");
      await this.git.run(["config", "--replace-all", "remote.origin.fetch", remote.fetchRefspec], {
        gitDir,
      });
      await this.git.run(["fetch", "--prune", "--tags", "origin"], { gitDir });
      await this.git.run(["remote", "set-head", "origin", "--auto"], {
        gitDir,
        reject: false,
      });

      const defaultBranch = await this.findCloneDefaultBranch(gitDir, remote.name);
      const config: WorkspaceConfig = {
        schemaVersion: 2,
        mode: "managed",
        gitDir: "../repo.git",
        envDir: "env",
        worktreeDir: "..",
        remote,
        defaultBranch,
        primaryWorktree: null,
      };

      await this.writeConfig(configPath, config);
      return await this.toWorkspace(configPath, config);
    } catch (error) {
      await Promise.all([
        fs.rm(gitDir, { force: true, recursive: true }),
        fs.rm(metadataDir, { force: true, recursive: true }),
      ]);
      if (!rootExisted) {
        await fs.rmdir(root).catch(() => undefined);
      }
      throw error;
    }
  }

  async inspectAdoption(
    repositoryPath = process.cwd(),
    options: AdoptionOptions = {},
    startDirectory = process.cwd(),
  ): Promise<AdoptionInspection> {
    const source = await this.canonicalDirectory(path.resolve(startDirectory, repositoryPath));
    const discoveredWorkspace = await this.findOptionalWorkspace(source);
    const discoveredGitDir = await this.findGitCommonDir(source);
    const gitDir = discoveredGitDir ?? discoveredWorkspace?.gitDir ?? null;
    if (!gitDir) {
      throw new WtError(`Not a Git repository: ${source}`);
    }

    const bareResult = await this.git.run(["rev-parse", "--is-bare-repository"], {
      gitDir,
    });
    const bare = bareResult.stdout === "true";
    const parsed = await this.readGitWorktrees(gitDir);
    const worktrees = parsed.map(toAdoptionWorktree);
    const primaryRecord = bare ? null : (parsed.find((worktree) => !worktree.bare) ?? null);
    const primaryWorktree = primaryRecord ? await canonicalPath(primaryRecord.path) : null;
    const remotes = await this.readRemotes(gitDir);
    const existingWorkspace = await this.findExistingWorkspace(gitDir, discoveredWorkspace);

    if (existingWorkspace) {
      await this.assertCompatibleReadoption(existingWorkspace, options, startDirectory);
      return {
        source,
        gitDir,
        bare,
        primaryWorktree: existingWorkspace.primaryWorktree,
        worktrees,
        remotes,
        remoteName: existingWorkspace.config.remote?.name ?? null,
        remoteSelectionRequired: false,
        defaultBranch: existingWorkspace.config.defaultBranch,
        defaultBranchCandidates: await this.readLocalBranches(gitDir),
        worktreeDir: existingWorkspace.worktreeDir,
        worktreeDirSelectionRequired: false,
        metadataDir: path.dirname(existingWorkspace.configPath),
        existingWorkspace,
      };
    }

    const remoteChoice = this.resolveRemoteChoice(remotes, options.remote);
    const defaultBranchCandidates = await this.readLocalBranches(gitDir);
    const defaultBranch = options.defaultBranch
      ? await this.validateDefaultBranch(gitDir, options.defaultBranch, remoteChoice.name)
      : remoteChoice.selectionRequired
        ? null
        : await this.inferDefaultBranch(gitDir, bare, remoteChoice.name, defaultBranchCandidates);
    const worktreeDir = options.worktreeDir
      ? path.resolve(startDirectory, options.worktreeDir)
      : this.suggestWorktreeDir(gitDir, bare, primaryWorktree, parsed);

    let worktreeDirSelectionRequired = false;
    try {
      await this.validateWorktreeDir(worktreeDir, gitDir, parsed);
    } catch (error) {
      if (options.worktreeDir) {
        throw error;
      }
      worktreeDirSelectionRequired = true;
    }

    return {
      source,
      gitDir,
      bare,
      primaryWorktree,
      worktrees,
      remotes,
      remoteName: remoteChoice.name,
      remoteSelectionRequired: remoteChoice.selectionRequired,
      defaultBranch,
      defaultBranchCandidates,
      worktreeDir,
      worktreeDirSelectionRequired,
      metadataDir: path.join(gitDir, "wt"),
      existingWorkspace: null,
    };
  }

  async adopt(inspection: AdoptionInspection): Promise<Workspace> {
    if (inspection.existingWorkspace) {
      return inspection.existingWorkspace;
    }
    if (inspection.remoteSelectionRequired) {
      throw new WtError("Multiple remotes found. Select one with --remote or use --no-remote.");
    }
    if (!inspection.defaultBranch) {
      throw new WtError("Could not determine the default branch. Use --default-branch.");
    }
    if (inspection.worktreeDirSelectionRequired) {
      throw new WtError("Could not select a safe worktree directory. Use --worktrees-dir.");
    }

    await this.validateWorktreeDir(inspection.worktreeDir, inspection.gitDir);
    if (inspection.remoteName) {
      const remotes = await this.readRemotes(inspection.gitDir);
      if (!remotes.includes(inspection.remoteName)) {
        throw new WtError(`Git remote no longer exists: ${inspection.remoteName}`);
      }
    }
    await this.validateDefaultBranch(
      inspection.gitDir,
      inspection.defaultBranch,
      inspection.remoteName,
    );

    const metadataDir = inspection.metadataDir;
    const configPath = path.join(metadataDir, "config.json");
    const envDir = path.join(metadataDir, "env");
    const markerPath = path.join(inspection.worktreeDir, ".wt");
    const metadataExisted = await this.pathExists(metadataDir);
    const worktreeDirExisted = await this.pathExists(inspection.worktreeDir);
    const markerExisted = await lstatOrNull(markerPath);

    if (metadataExisted) {
      throw new WtError(`Adoption metadata already exists without a valid config: ${metadataDir}`);
    }
    if (markerExisted) {
      throw new WtError(`Worktree directory already contains a .wt entry: ${markerPath}`);
    }
    if (worktreeDirExisted && !(await fs.stat(inspection.worktreeDir)).isDirectory()) {
      throw new WtError(`Worktree directory is not a directory: ${inspection.worktreeDir}`);
    }

    let createdMetadata = false;
    let createdMarker = false;
    let createdWorktreeDir = false;
    try {
      if (!worktreeDirExisted) {
        await fs.mkdir(inspection.worktreeDir, { recursive: true });
        createdWorktreeDir = true;
      }
      await fs.mkdir(metadataDir, { mode: 0o700 });
      createdMetadata = true;
      await fs.mkdir(envDir, { mode: 0o700 });
      await fs.chmod(metadataDir, 0o700);
      await fs.chmod(envDir, 0o700);

      const config: WorkspaceConfig = {
        schemaVersion: 2,
        mode: "adopted",
        gitDir: relativeConfigPath(metadataDir, inspection.gitDir),
        envDir: "env",
        worktreeDir: relativeConfigPath(metadataDir, inspection.worktreeDir),
        remote: inspection.remoteName ? createRemote(inspection.remoteName) : null,
        defaultBranch: inspection.defaultBranch,
        primaryWorktree: inspection.primaryWorktree
          ? relativeConfigPath(metadataDir, inspection.primaryWorktree)
          : null,
      };

      await this.writeConfig(configPath, config);
      await fs.symlink(path.relative(inspection.worktreeDir, metadataDir), markerPath);
      createdMarker = true;
      return await this.toWorkspace(configPath, config);
    } catch (error) {
      if (createdMarker) {
        await fs.rm(markerPath, { force: true });
      }
      if (createdMetadata) {
        await fs.rm(metadataDir, { force: true, recursive: true });
      }
      if (createdWorktreeDir) {
        await fs.rmdir(inspection.worktreeDir).catch(() => undefined);
      }
      throw error;
    }
  }

  async find(startDirectory = process.cwd()): Promise<Workspace> {
    const start = path.resolve(startDirectory);
    let current = start;

    while (true) {
      const configPath = path.join(current, ".wt", "config.json");
      try {
        await fs.access(configPath, fsConstants.R_OK);
        return await this.read(configPath, current);
      } catch (error) {
        if (!this.isNotFound(error)) {
          throw error;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    const gitDir = await this.findGitCommonDir(start);
    if (gitDir) {
      const configPath = path.join(gitDir, "wt", "config.json");
      try {
        await fs.access(configPath, fsConstants.R_OK);
        return await this.read(configPath);
      } catch (error) {
        if (!this.isNotFound(error)) {
          throw error;
        }
      }
    }

    throw new WtError("No managed workspace found. Run this command inside a wt workspace.");
  }

  private async read(configPath: string, legacyRoot?: string): Promise<Workspace> {
    let realConfigPath: string;
    let raw: string;
    try {
      realConfigPath = await fs.realpath(configPath);
      raw = await fs.readFile(realConfigPath, "utf8");
    } catch (error) {
      throw new WtError(`Cannot read workspace configuration: ${configPath}`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new WtError(`Workspace configuration is not valid JSON: ${configPath}`, {
        cause: error,
      });
    }

    const currentResult = workspaceConfigSchema.safeParse(parsed);
    if (currentResult.success) {
      return await this.toWorkspace(realConfigPath, currentResult.data);
    }

    const legacyResult = legacyWorkspaceConfigSchema.safeParse(parsed);
    if (legacyResult.success && legacyRoot) {
      return await this.toWorkspace(
        realConfigPath,
        this.normalizeLegacyConfig(realConfigPath, legacyRoot, legacyResult.data),
      );
    }

    const issue = currentResult.error.issues[0]?.message ?? "Unknown configuration error";
    throw new WtError(`Workspace configuration is invalid: ${issue}`);
  }

  private async toWorkspace(configPath: string, config: WorkspaceConfig): Promise<Workspace> {
    const canonicalConfigPath = await canonicalPath(configPath);
    const configDir = path.dirname(canonicalConfigPath);
    for (const [label, value] of [
      ["gitDir", config.gitDir],
      ["envDir", config.envDir],
      ["worktreeDir", config.worktreeDir],
      ["primaryWorktree", config.primaryWorktree],
    ] as const) {
      if (value && path.isAbsolute(value)) {
        throw new WtError(`${label} must be relative to the workspace configuration.`);
      }
    }

    const gitDir = await canonicalPath(path.resolve(configDir, config.gitDir));
    const envDir = await canonicalPath(path.resolve(configDir, config.envDir));
    const worktreeDir = await canonicalPath(path.resolve(configDir, config.worktreeDir));
    const primaryWorktree = config.primaryWorktree
      ? await canonicalPath(path.resolve(configDir, config.primaryWorktree))
      : null;

    if (config.mode === "managed") {
      if (primaryWorktree) {
        throw new WtError("Managed bare workspaces cannot define a primary worktree.");
      }
      if (!isPathInsideOrEqual(worktreeDir, gitDir) || !isPathInsideOrEqual(worktreeDir, envDir)) {
        throw new WtError("Managed workspace paths must stay inside the workspace root.");
      }
    } else {
      if (configDir !== path.join(gitDir, "wt")) {
        throw new WtError("Adopted workspace configuration must stay inside the Git directory.");
      }
      if (!isPathInsideOrEqual(configDir, envDir)) {
        throw new WtError("Adopted environment files must stay inside the wt metadata directory.");
      }
      if (isPathInsideOrEqual(gitDir, worktreeDir)) {
        throw new WtError("Adopted worktree directory must stay outside the Git directory.");
      }
      if (primaryWorktree && isPathInsideOrEqual(primaryWorktree, worktreeDir)) {
        throw new WtError("Adopted worktree directory must stay outside the primary checkout.");
      }
    }

    return {
      root: worktreeDir,
      configPath: canonicalConfigPath,
      gitDir,
      envDir,
      worktreeDir,
      primaryWorktree,
      config,
    };
  }

  private normalizeLegacyConfig(
    configPath: string,
    root: string,
    legacy: LegacyWorkspaceConfig,
  ): WorkspaceConfig {
    const configDir = path.dirname(configPath);
    return {
      schemaVersion: 2,
      mode: "managed",
      gitDir: relativeConfigPath(configDir, path.resolve(root, legacy.gitDir)),
      envDir: relativeConfigPath(configDir, path.resolve(root, legacy.envDir)),
      worktreeDir: relativeConfigPath(configDir, root),
      remote: createRemote(legacy.remote),
      defaultBranch: legacy.defaultBranch,
      primaryWorktree: null,
    };
  }

  private async findCloneDefaultBranch(gitDir: string, remote: string): Promise<string> {
    const remoteHead = await this.git.run(
      ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
      { gitDir, reject: false },
    );
    if (remoteHead.exitCode === 0 && remoteHead.stdout.startsWith(`${remote}/`)) {
      return remoteHead.stdout.slice(remote.length + 1);
    }

    const localHead = await this.git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      gitDir,
      reject: false,
    });
    if (localHead.exitCode === 0) {
      return localHead.stdout.replace(/^refs\/heads\//u, "");
    }

    throw new WtError("Could not determine the repository's default branch.");
  }

  private async inferDefaultBranch(
    gitDir: string,
    bare: boolean,
    remote: string | null,
    localBranches: string[],
  ): Promise<string | null> {
    if (remote) {
      const remoteHead = await this.git.run(
        ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
        { gitDir, reject: false },
      );
      if (remoteHead.exitCode === 0 && remoteHead.stdout.startsWith(`${remote}/`)) {
        return remoteHead.stdout.slice(remote.length + 1);
      }
    }

    if (bare) {
      const head = await this.git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], {
        gitDir,
        reject: false,
      });
      if (head.exitCode === 0) {
        return head.stdout.replace(/^refs\/heads\//u, "");
      }
    }

    return localBranches.length === 1 ? (localBranches[0] ?? null) : null;
  }

  private async validateDefaultBranch(
    gitDir: string,
    branch: string,
    remote: string | null,
  ): Promise<string> {
    const valid = await this.git.succeeds(["check-ref-format", "--branch", branch], { gitDir });
    if (!valid) {
      throw new WtError(`Invalid default branch: ${branch}`);
    }

    const references = [`refs/heads/${branch}`];
    if (remote) {
      references.unshift(`refs/remotes/${remote}/${branch}`);
    }
    for (const reference of references) {
      if (
        await this.git.succeeds(["rev-parse", "--verify", "--quiet", `${reference}^{commit}`], {
          gitDir,
        })
      ) {
        return branch;
      }
    }
    throw new WtError(`Default branch does not resolve to a commit: ${branch}`);
  }

  private resolveRemoteChoice(
    remotes: string[],
    requested: string | null | undefined,
  ): { name: string | null; selectionRequired: boolean } {
    if (requested !== undefined) {
      if (requested && !remotes.includes(requested)) {
        throw new WtError(`Unknown Git remote: ${requested}`);
      }
      return { name: requested, selectionRequired: false };
    }
    if (remotes.length === 0) {
      return { name: null, selectionRequired: false };
    }
    if (remotes.length === 1) {
      return { name: remotes[0] ?? null, selectionRequired: false };
    }
    return { name: null, selectionRequired: true };
  }

  private suggestWorktreeDir(
    gitDir: string,
    bare: boolean,
    primaryWorktree: string | null,
    worktrees: ParsedWorktree[],
  ): string {
    const linkedPaths = worktrees
      .filter((worktree) => !worktree.bare && worktree.path !== primaryWorktree)
      .map((worktree) => path.resolve(worktree.path));
    const commonParent = commonDirectParent(linkedPaths);

    if (bare && commonParent) {
      return commonParent;
    }
    if (!bare && primaryWorktree) {
      if (commonParent && commonParent !== path.dirname(primaryWorktree)) {
        return commonParent;
      }
      return path.join(
        path.dirname(primaryWorktree),
        `${path.basename(primaryWorktree)}-worktrees`,
      );
    }
    if (bare && path.basename(gitDir) === "repo.git") {
      return path.dirname(gitDir);
    }

    const repositoryName = path.basename(gitDir).replace(/\.git$/u, "") || "repository";
    return path.join(path.dirname(gitDir), `${repositoryName}-worktrees`);
  }

  private async validateWorktreeDir(
    worktreeDir: string,
    gitDir: string,
    knownWorktrees?: ParsedWorktree[],
  ): Promise<void> {
    const resolved = path.resolve(worktreeDir);
    if (isPathInsideOrEqual(gitDir, resolved)) {
      throw new WtError("Worktree directory must stay outside the Git directory.");
    }

    const worktrees = knownWorktrees ?? (await this.readGitWorktrees(gitDir));
    for (const worktree of worktrees.filter((candidate) => !candidate.bare)) {
      if (isPathInsideOrEqual(worktree.path, resolved)) {
        throw new WtError(
          `Worktree directory must not be inside an existing worktree: ${worktree.path}`,
        );
      }
    }

    const stat = await lstatOrNull(resolved);
    if (stat && !stat.isDirectory()) {
      throw new WtError(`Worktree directory is not a directory: ${resolved}`);
    }
    if (await lstatOrNull(path.join(resolved, ".wt"))) {
      throw new WtError(`Worktree directory already contains a .wt entry: ${resolved}`);
    }
  }

  private async findGitCommonDir(source: string): Promise<string | null> {
    const result = await this.git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: source,
      reject: false,
    });
    if (result.exitCode !== 0 || !result.stdout) {
      return null;
    }
    return await canonicalPath(path.resolve(source, result.stdout));
  }

  private async findExistingWorkspace(
    gitDir: string,
    discoveredWorkspace: Workspace | null,
  ): Promise<Workspace | null> {
    if (discoveredWorkspace && (await canonicalPath(discoveredWorkspace.gitDir)) === gitDir) {
      return discoveredWorkspace;
    }

    const configPath = path.join(gitDir, "wt", "config.json");
    try {
      await fs.access(configPath, fsConstants.R_OK);
      return await this.read(configPath);
    } catch (error) {
      if (this.isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async findOptionalWorkspace(source: string): Promise<Workspace | null> {
    try {
      return await this.find(source);
    } catch (error) {
      if (error instanceof WtError && error.message.startsWith("No managed workspace found")) {
        return null;
      }
      throw error;
    }
  }

  private async assertCompatibleReadoption(
    workspace: Workspace,
    options: AdoptionOptions,
    startDirectory: string,
  ): Promise<void> {
    if (
      options.worktreeDir &&
      (await canonicalPath(path.resolve(startDirectory, options.worktreeDir))) !==
        workspace.worktreeDir
    ) {
      throw new WtError("Repository is already initialized with a different worktree directory.");
    }
    if (
      options.remote !== undefined &&
      options.remote !== (workspace.config.remote?.name ?? null)
    ) {
      throw new WtError("Repository is already initialized with a different remote.");
    }
    if (options.defaultBranch && options.defaultBranch !== workspace.config.defaultBranch) {
      throw new WtError("Repository is already initialized with a different default branch.");
    }
  }

  private async readGitWorktrees(gitDir: string): Promise<ParsedWorktree[]> {
    const result = await this.git.run(["worktree", "list", "--porcelain", "-z"], { gitDir });
    return parseWorktreePorcelain(result.stdout);
  }

  private async readRemotes(gitDir: string): Promise<string[]> {
    const result = await this.git.run(["remote"], { gitDir });
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  private async readLocalBranches(gitDir: string): Promise<string[]> {
    const result = await this.git.run(["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
      gitDir,
    });
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  private async writeConfig(configPath: string, config: WorkspaceConfig): Promise<void> {
    const tempPath = `${configPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, configPath);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }

  private async canonicalDirectory(target: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await fs.realpath(target);
    } catch (error) {
      throw new WtError(`Repository path does not exist: ${target}`, { cause: error });
    }
    if (!(await fs.stat(canonical)).isDirectory()) {
      throw new WtError(`Repository path is not a directory: ${target}`);
    }
    return canonical;
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch (error) {
      if (this.isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

function createRemote(name: string): WorkspaceRemote {
  return {
    name,
    fetchRefspec: `+refs/heads/*:refs/remotes/${name}/*`,
  };
}

function relativeConfigPath(configDir: string, target: string): string {
  return path.relative(configDir, target) || ".";
}

function commonDirectParent(paths: string[]): string | null {
  if (paths.length === 0) {
    return null;
  }
  const parent = path.dirname(paths[0] as string);
  return paths.every((candidate) => path.dirname(candidate) === parent) ? parent : null;
}

function toAdoptionWorktree(worktree: ParsedWorktree): AdoptionWorktree {
  return {
    path: worktree.path,
    branch: worktree.branch,
    branchRef: worktree.branchRef,
    locked: worktree.locked,
    lockReason: worktree.lockReason,
    prunable: worktree.prunable,
    bare: worktree.bare,
  };
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
