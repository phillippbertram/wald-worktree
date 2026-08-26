import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WtError } from "../domain/errors.js";
import type { Workspace, WorkspaceConfig, WorkspaceRemote, Worktree } from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";
import { humanizeRepositoryName, isPathInsideOrEqual } from "../infrastructure/path-utils.js";
import { ConfigService, workspaceConfigFileName } from "./config-service.js";
import { type ParsedWorktree, parseWorktreePorcelain } from "./worktree-service.js";

export type AdoptionOptions = {
  worktreeDir?: string;
  remote?: string | null;
  defaultBranch?: string;
};

export type ManagedInitializationOptions = {
  worktreeDir?: string;
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
  modified: boolean;
  modifiedWorktrees: string[];
  detachedWorktrees: string[];
  stashCount: number;
};

export class WorkspaceService {
  constructor(
    private readonly git: GitClient,
    private readonly configs = new ConfigService(),
  ) {}

  async initialize(
    repository: string,
    directory?: string,
    startDirectory = process.cwd(),
    options: ManagedInitializationOptions = {},
  ): Promise<Workspace> {
    const root = path.resolve(startDirectory, directory ?? humanizeRepositoryName(repository));
    const gitDir = path.join(root, "repo.git");
    const metadataDir = path.join(root, ".wt");
    const sharedDir = path.join(metadataDir, "shared");
    const worktreeDir = resolveManagedWorktreeDir(root, options.worktreeDir);
    const configPath = path.join(metadataDir, workspaceConfigFileName);
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
      await fs.mkdir(sharedDir, { mode: 0o700 });
      if (worktreeDir !== root) {
        await fs.mkdir(worktreeDir, { recursive: true });
      }
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
        version: 1,
        mode: "managed",
        paths: {
          git: "../repo.git",
          worktrees: relativeConfigPath(metadataDir, worktreeDir),
          primaryWorktree: null,
        },
        remote,
        defaultBranch,
        trustedProjectConfig: null,
      };

      await this.configs.writeWorkspaceConfig(configPath, config);
      return await this.toWorkspace(configPath, config);
    } catch (error) {
      await Promise.all([
        fs.rm(gitDir, { force: true, recursive: true }),
        fs.rm(metadataDir, { force: true, recursive: true }),
        worktreeDir === root
          ? Promise.resolve()
          : fs.rm(worktreeDir, { force: true, recursive: true }),
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
    const modifiedWorktrees = (
      await Promise.all(
        worktrees
          .filter((worktree) => !worktree.bare)
          .map(async (worktree) => ({
            path: worktree.path,
            modified: await this.isModified(worktree.path),
          })),
      )
    )
      .filter((worktree) => worktree.modified)
      .map((worktree) => worktree.path);
    const detachedWorktrees = worktrees
      .filter((worktree) => !worktree.bare && !worktree.branchRef)
      .map((worktree) => worktree.path);
    const modified = primaryWorktree ? modifiedWorktrees.includes(primaryWorktree) : false;
    const stashCount = primaryWorktree ? await this.readStashCount(primaryWorktree) : 0;

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
        modified,
        modifiedWorktrees,
        detachedWorktrees,
        stashCount,
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
      modified,
      modifiedWorktrees,
      detachedWorktrees,
      stashCount,
    };
  }

  async initializeFromExisting(
    inspection: AdoptionInspection,
    directory: string,
    startDirectory = process.cwd(),
    options: ManagedInitializationOptions = {},
  ): Promise<Workspace> {
    if (inspection.remoteSelectionRequired) {
      throw new WtError("Multiple remotes found. Select one before creating a new workspace.");
    }
    if (!inspection.defaultBranch) {
      throw new WtError("Could not determine the default branch.");
    }

    const root = path.resolve(startDirectory, directory);
    const gitDir = path.join(root, "repo.git");
    const metadataDir = path.join(root, ".wt");
    const sharedDir = path.join(metadataDir, "shared");
    const worktreeDir = resolveManagedWorktreeDir(root, options.worktreeDir);
    const configPath = path.join(metadataDir, workspaceConfigFileName);
    const rootExisted = await this.pathExists(root);
    if (rootExisted) {
      const entries = await fs.readdir(root);
      if (entries.length > 0) {
        throw new WtError(`Target directory is not empty: ${root}`);
      }
    } else {
      await fs.mkdir(root, { recursive: true });
    }

    const cloneSource = inspection.primaryWorktree ?? inspection.gitDir;
    const remoteUrl = inspection.remoteName
      ? await this.readRemoteUrl(inspection.gitDir, inspection.remoteName)
      : null;

    try {
      await fs.mkdir(metadataDir, { mode: 0o700 });
      await fs.mkdir(sharedDir, { mode: 0o700 });
      if (worktreeDir !== root) {
        await fs.mkdir(worktreeDir, { recursive: true });
      }
      await this.git.run(["clone", "--bare", "--", cloneSource, gitDir], {
        cwd: startDirectory,
      });
      await this.git.run(["remote", "remove", "origin"], { gitDir, reject: false });

      const remote = inspection.remoteName ? createRemote(inspection.remoteName) : null;
      if (remote && remoteUrl) {
        await this.git.run(["remote", "add", remote.name, remoteUrl], { gitDir });
        await this.git.run(
          ["config", "--replace-all", `remote.${remote.name}.fetch`, remote.fetchRefspec],
          { gitDir },
        );
      }
      await this.ensureCopiedDefaultBranch(
        inspection.gitDir,
        gitDir,
        inspection.defaultBranch,
        inspection.remoteName,
      );
      await this.git.run(["symbolic-ref", "HEAD", `refs/heads/${inspection.defaultBranch}`], {
        gitDir,
      });

      const config: WorkspaceConfig = {
        version: 1,
        mode: "managed",
        paths: {
          git: "../repo.git",
          worktrees: relativeConfigPath(metadataDir, worktreeDir),
          primaryWorktree: null,
        },
        remote,
        defaultBranch: inspection.defaultBranch,
        trustedProjectConfig: null,
      };
      await this.configs.writeWorkspaceConfig(configPath, config);
      return await this.toWorkspace(configPath, config);
    } catch (error) {
      await Promise.all([
        fs.rm(gitDir, { force: true, recursive: true }),
        fs.rm(metadataDir, { force: true, recursive: true }),
        worktreeDir === root
          ? Promise.resolve()
          : fs.rm(worktreeDir, { force: true, recursive: true }),
      ]);
      if (!rootExisted) {
        await fs.rmdir(root).catch(() => undefined);
      }
      throw error;
    }
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
    const configPath = path.join(metadataDir, workspaceConfigFileName);
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
      await fs.chmod(metadataDir, 0o700);
      await fs.mkdir(path.join(metadataDir, "shared"), { mode: 0o700 });

      const config: WorkspaceConfig = {
        version: 1,
        mode: "adopted",
        paths: {
          git: relativeConfigPath(metadataDir, inspection.gitDir),
          worktrees: relativeConfigPath(metadataDir, inspection.worktreeDir),
          primaryWorktree: inspection.primaryWorktree
            ? relativeConfigPath(metadataDir, inspection.primaryWorktree)
            : null,
        },
        remote: inspection.remoteName ? createRemote(inspection.remoteName) : null,
        defaultBranch: inspection.defaultBranch,
        trustedProjectConfig: null,
      };

      await this.configs.writeWorkspaceConfig(configPath, config);
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
      const configPath = path.join(current, ".wt", workspaceConfigFileName);
      try {
        await fs.access(configPath, fsConstants.R_OK);
        return await this.read(configPath);
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
      const configPath = path.join(gitDir, "wt", workspaceConfigFileName);
      try {
        await fs.access(configPath, fsConstants.R_OK);
        return await this.read(configPath);
      } catch (error) {
        if (!this.isNotFound(error)) {
          throw error;
        }
      }
    }

    throw new WtError("No wt workspace found. Run wt init inside or for this repository.");
  }

  async ensureSharedDirectory(workspace: Workspace): Promise<void> {
    const existing = await lstatOrNull(workspace.sharedDir);
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
      throw new WtError(
        `Shared path must be a directory, not a link or file: ${workspace.sharedDir}`,
      );
    }
    await fs.mkdir(workspace.sharedDir, { recursive: true, mode: 0o700 });
  }

  private async read(configPath: string): Promise<Workspace> {
    let realConfigPath: string;
    try {
      realConfigPath = await fs.realpath(configPath);
    } catch (error) {
      throw new WtError(`Cannot read workspace configuration: ${configPath}`, { cause: error });
    }
    return await this.toWorkspace(
      realConfigPath,
      await this.configs.readWorkspaceConfig(realConfigPath),
    );
  }

  private async toWorkspace(configPath: string, config: WorkspaceConfig): Promise<Workspace> {
    const canonicalConfigPath = await canonicalPath(configPath);
    const configDir = path.dirname(canonicalConfigPath);
    for (const [label, value] of [
      ["paths.git", config.paths.git],
      ["paths.worktrees", config.paths.worktrees],
      ["paths.primary_worktree", config.paths.primaryWorktree],
    ] as const) {
      if (value && path.isAbsolute(value)) {
        throw new WtError(`${label} must be relative to the workspace configuration.`);
      }
    }

    const gitDir = await canonicalPath(path.resolve(configDir, config.paths.git));
    const worktreeDir = await canonicalPath(path.resolve(configDir, config.paths.worktrees));
    const primaryWorktree = config.paths.primaryWorktree
      ? await canonicalPath(path.resolve(configDir, config.paths.primaryWorktree))
      : null;
    const sharedDir = path.join(configDir, "shared");
    const sharedStat = await lstatOrNull(sharedDir);
    if (sharedStat?.isSymbolicLink() || (sharedStat && !sharedStat.isDirectory())) {
      throw new WtError(`Shared path must be a directory, not a link or file: ${sharedDir}`);
    }

    let root: string;

    if (config.mode === "managed") {
      root = path.dirname(configDir);
      if (configDir !== path.join(root, ".wt")) {
        throw new WtError("Managed workspace configuration must stay in <workspace>/.wt.");
      }
      if (primaryWorktree) {
        throw new WtError("Managed bare workspaces cannot define a primary worktree.");
      }
      if (gitDir !== path.join(root, "repo.git")) {
        throw new WtError("Managed Git directory must be <workspace>/repo.git.");
      }
      if (!isPathInsideOrEqual(root, worktreeDir)) {
        throw new WtError("Managed workspace paths must stay inside the workspace root.");
      }
      if (
        worktreeDir === gitDir ||
        isPathInsideOrEqual(gitDir, worktreeDir) ||
        isPathInsideOrEqual(configDir, worktreeDir)
      ) {
        throw new WtError("Managed worktree directory overlaps reserved workspace metadata.");
      }
    } else {
      root = worktreeDir;
      if (configDir !== path.join(gitDir, "wt")) {
        throw new WtError("Adopted workspace configuration must stay inside the Git directory.");
      }
      if (isPathInsideOrEqual(gitDir, worktreeDir)) {
        throw new WtError("Adopted worktree directory must stay outside the Git directory.");
      }
      if (primaryWorktree && isPathInsideOrEqual(primaryWorktree, worktreeDir)) {
        throw new WtError("Adopted worktree directory must stay outside the primary checkout.");
      }
    }

    return {
      root,
      configPath: canonicalConfigPath,
      sharedDir,
      gitDir,
      worktreeDir,
      primaryWorktree,
      config,
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

    const configPath = path.join(gitDir, "wt", workspaceConfigFileName);
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
      if (error instanceof WtError && error.message.startsWith("No wt workspace found")) {
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

  private async readRemoteUrl(gitDir: string, remote: string): Promise<string> {
    const result = await this.git.run(["remote", "get-url", remote], { gitDir });
    return result.stdout;
  }

  private async isModified(worktree: string): Promise<boolean> {
    const result = await this.git.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
      { cwd: worktree, reject: false },
    );
    return result.exitCode === 0 && result.stdout.length > 0;
  }

  private async readStashCount(worktree: string): Promise<number> {
    const result = await this.git.run(["stash", "list", "--format=%gd"], { cwd: worktree });
    return result.stdout ? result.stdout.split("\n").filter(Boolean).length : 0;
  }

  private async ensureCopiedDefaultBranch(
    sourceGitDir: string,
    targetGitDir: string,
    branch: string,
    remote: string | null,
  ): Promise<void> {
    if (
      await this.git.succeeds(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
        {
          gitDir: targetGitDir,
        },
      )
    ) {
      return;
    }
    const sourceReference = remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`;
    await this.git.run(
      ["fetch", "--no-tags", sourceGitDir, `${sourceReference}:refs/heads/${branch}`],
      { gitDir: targetGitDir },
    );
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

function resolveManagedWorktreeDir(root: string, requested?: string): string {
  const resolved = requested ? path.resolve(root, requested) : root;
  if (!isPathInsideOrEqual(root, resolved)) {
    throw new WtError("Managed worktree directory must stay inside the workspace root.");
  }
  if (
    resolved === path.join(root, "repo.git") ||
    isPathInsideOrEqual(path.join(root, "repo.git"), resolved) ||
    resolved === path.join(root, ".wt") ||
    isPathInsideOrEqual(path.join(root, ".wt"), resolved)
  ) {
    throw new WtError("Managed worktree directory overlaps reserved workspace metadata.");
  }
  return resolved;
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
