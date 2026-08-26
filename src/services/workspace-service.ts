import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WtError } from "../domain/errors.js";
import type { Workspace, WorkspaceConfig } from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";
import {
  humanizeRepositoryName,
  isPathInside,
  isPathInsideOrEqual,
} from "../infrastructure/path-utils.js";

const workspaceConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    gitDir: z.string().min(1),
    envDir: z.string().min(1),
    remote: z.string().min(1),
    defaultBranch: z.string().min(1),
  })
  .strict();

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
      await this.git.run(["clone", "--bare", "--", repository, gitDir], { cwd: startDirectory });
      await this.git.run(
        ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        { gitDir },
      );
      await this.git.run(["fetch", "--prune", "--tags", "origin"], { gitDir });
      await this.git.run(["remote", "set-head", "origin", "--auto"], { gitDir, reject: false });

      const defaultBranch = await this.findDefaultBranch(gitDir);
      const config: WorkspaceConfig = {
        schemaVersion: 1,
        gitDir: "repo.git",
        envDir: ".wt/env",
        remote: "origin",
        defaultBranch,
      };

      await this.writeConfig(configPath, config);
      const canonicalRoot = await fs.realpath(root);
      return this.toWorkspace(
        canonicalRoot,
        path.join(canonicalRoot, ".wt", "config.json"),
        config,
      );
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

  async find(startDirectory = process.cwd()): Promise<Workspace> {
    let current = path.resolve(startDirectory);

    while (true) {
      const configPath = path.join(current, ".wt", "config.json");
      try {
        await fs.access(configPath, fsConstants.R_OK);
        return await this.read(current, configPath);
      } catch (error) {
        if (!this.isNotFound(error)) {
          throw error;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw new WtError("No managed workspace found. Run this command inside a wt workspace.");
      }
      current = parent;
    }
  }

  private async read(root: string, configPath: string): Promise<Workspace> {
    let raw: string;
    try {
      raw = await fs.readFile(configPath, "utf8");
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

    const result = workspaceConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new WtError(`Workspace configuration is invalid: ${result.error.issues[0]?.message}`);
    }

    return this.toWorkspace(root, configPath, result.data);
  }

  private toWorkspace(root: string, configPath: string, config: WorkspaceConfig): Workspace {
    for (const [label, value] of [
      ["gitDir", config.gitDir],
      ["envDir", config.envDir],
    ] as const) {
      if (path.isAbsolute(value)) {
        throw new WtError(`${label} must be relative to the workspace root.`);
      }
      const resolved = path.resolve(root, value);
      if (!isPathInside(root, resolved)) {
        throw new WtError(`${label} must stay inside the workspace root.`);
      }
    }

    const gitDir = path.resolve(root, config.gitDir);
    const envDir = path.resolve(root, config.envDir);
    if (!isPathInsideOrEqual(root, gitDir) || !isPathInsideOrEqual(root, envDir)) {
      throw new WtError("Workspace paths must stay inside the workspace root.");
    }

    return { root, configPath, gitDir, envDir, config };
  }

  private async findDefaultBranch(gitDir: string): Promise<string> {
    const remoteHead = await this.git.run(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { gitDir, reject: false },
    );
    if (remoteHead.exitCode === 0 && remoteHead.stdout.startsWith("origin/")) {
      return remoteHead.stdout.slice("origin/".length);
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

  private async writeConfig(configPath: string, config: WorkspaceConfig): Promise<void> {
    const tempPath = `${configPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, configPath);
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
