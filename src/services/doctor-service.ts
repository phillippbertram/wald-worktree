import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { toErrorMessage, YggError } from "../domain/errors.js";
import type {
  AutomationStep,
  ProjectConfigDocument,
  StepSource,
  Workspace,
  Worktree,
} from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";
import { isPathInsideOrEqual } from "../infrastructure/path-utils.js";
import { redactSensitiveText, sanitizeTerminalText } from "../infrastructure/safe-text.js";
import type { ConfigService } from "./config-service.js";
import { commandExists, type ToolService } from "./tool-service.js";
import type { WorkspaceService } from "./workspace-service.js";
import type { WorktreeService } from "./worktree-service.js";

export type DoctorCheckStatus = "pass" | "warning" | "fail" | "skipped";

export type DoctorCheck = {
  id: string;
  status: DoctorCheckStatus;
  summary: string;
  suggestion?: string;
};

export type DoctorReport = {
  status: "pass" | "warning" | "fail";
  checks: DoctorCheck[];
};

const minimumNodeVersion = [22, 13, 0] as const;
const minimumGitVersion = [2, 31, 0] as const;

export class DoctorService {
  constructor(
    private readonly git: GitClient,
    private readonly workspaces: WorkspaceService,
    private readonly worktrees: WorktreeService,
    private readonly configs: ConfigService,
    private readonly tools: ToolService,
    private readonly runtime: { nodeVersion: string } = { nodeVersion: process.versions.node },
  ) {}

  async inspect(startDirectory = process.cwd()): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    checks.push(this.nodeCheck());
    checks.push(await this.gitVersionCheck());

    let workspace: Workspace;
    try {
      workspace = await this.workspaces.find(startDirectory);
      checks.push({
        id: "workspace.discovery",
        status: "pass",
        summary: "Ygg workspace configuration was discovered and validated.",
      });
    } catch (error) {
      if (error instanceof YggError && error.message.startsWith("No ygg workspace found")) {
        checks.push({
          id: "workspace.discovery",
          status: "warning",
          summary: "No Ygg workspace was found from the current directory.",
          suggestion: "Run ygg init in a Git repository or provide a repository to clone.",
        });
      } else {
        checks.push({
          id: "workspace.configuration",
          status: "fail",
          summary: "Workspace discovery or configuration validation failed.",
          suggestion: "Repair the workspace configuration, then run ygg doctor again.",
        });
      }
      checks.push({
        id: "workspace.details",
        status: "skipped",
        summary: "Workspace-specific checks require a valid workspace configuration.",
      });
      return report(checks);
    }

    checks.push({
      id: "workspace.configuration",
      status: "pass",
      summary: "Workspace YAML syntax, schema, and configured path boundaries are valid.",
    });
    await this.inspectPaths(workspace, checks);
    await this.inspectGitIdentity(workspace, startDirectory, checks);
    await this.inspectRemote(workspace, checks);

    let worktrees: Worktree[] = [];
    try {
      worktrees = await this.worktrees.list(workspace);
      this.inspectWorktrees(workspace, worktrees, checks);
    } catch (error) {
      checks.push({
        id: "git.worktrees",
        status: "fail",
        summary: `Git worktrees could not be inspected: ${safeMessage(error)}`,
        suggestion: "Run git worktree repair after verifying the configured paths.",
      });
    }

    await this.inspectProject(workspace, worktrees, checks);
    return report(checks);
  }

  private nodeCheck(): DoctorCheck {
    const version = parseVersion(this.runtime.nodeVersion);
    return version && versionAtLeast(version, minimumNodeVersion)
      ? {
          id: "runtime.node",
          status: "pass",
          summary: `Node.js ${this.runtime.nodeVersion} satisfies the minimum version 22.13.0.`,
        }
      : {
          id: "runtime.node",
          status: "fail",
          summary: `Node.js ${this.runtime.nodeVersion} does not satisfy the minimum version 22.13.0.`,
          suggestion: "Install Node.js 22.13.0 or newer.",
        };
  }

  private async gitVersionCheck(): Promise<DoctorCheck> {
    try {
      const result = await this.git.run(["--version"]);
      const versionText = result.stdout.match(/\d+\.\d+(?:\.\d+)?/u)?.[0];
      const version = versionText ? parseVersion(versionText) : null;
      if (version && versionAtLeast(version, minimumGitVersion)) {
        return {
          id: "runtime.git",
          status: "pass",
          summary: `Git ${versionText} satisfies the minimum version 2.31.0.`,
        };
      }
      return {
        id: "runtime.git",
        status: "fail",
        summary: versionText
          ? `Git ${versionText} does not satisfy the minimum version 2.31.0.`
          : "The Git version could not be determined.",
        suggestion: "Install Git 2.31.0 or newer.",
      };
    } catch (error) {
      return {
        id: "runtime.git",
        status: "fail",
        summary: safeMessage(error),
        suggestion: "Install Git 2.31.0 or newer and ensure it is available in PATH.",
      };
    }
  }

  private async inspectPaths(workspace: Workspace, checks: DoctorCheck[]): Promise<void> {
    const metadataDir = path.dirname(workspace.configPath);
    checks.push(await directoryCheck("paths.git", "Git common directory", workspace.gitDir, true));
    checks.push(await directoryCheck("paths.metadata", "Metadata directory", metadataDir, true));
    checks.push(
      await directoryCheck(
        "paths.worktrees",
        "Worktree directory",
        workspace.worktreeDir,
        false,
        "Run ygg init again to restore missing workspace directories.",
      ),
    );
    checks.push(
      await directoryCheck(
        "paths.shared",
        "Shared directory",
        workspace.sharedDir,
        false,
        "Run ygg init again to restore missing workspace directories.",
      ),
    );
    if (workspace.primaryWorktree) {
      checks.push(
        await directoryCheck("paths.primary", "Primary worktree", workspace.primaryWorktree, true),
      );
    } else {
      checks.push({
        id: "paths.primary",
        status: "skipped",
        summary: "This managed workspace has no primary checkout.",
      });
    }

    if (workspace.config.mode === "adopted") {
      const markerPath = path.join(workspace.worktreeDir, ".ygg");
      try {
        const marker = await fs.lstat(markerPath);
        const markerTarget = await fs.realpath(markerPath);
        const metadataTarget = await fs.realpath(metadataDir);
        checks.push(
          marker.isSymbolicLink() && markerTarget === metadataTarget
            ? {
                id: "workspace.marker",
                status: "pass",
                summary: "The .ygg marker resolves to this workspace metadata directory.",
              }
            : {
                id: "workspace.marker",
                status: "fail",
                summary: "The .ygg marker does not resolve to this workspace metadata directory.",
                suggestion: "Run ygg init --adopt . --yes to repair the workspace marker.",
              },
        );
      } catch (error) {
        checks.push({
          id: "workspace.marker",
          status: "fail",
          summary: `The .ygg marker could not be resolved: ${safeMessage(error)}`,
          suggestion: "Run ygg init --adopt . --yes to repair the workspace marker.",
        });
      }
    } else {
      checks.push({
        id: "workspace.marker",
        status: "skipped",
        summary: "Managed workspaces do not use a worktree-root .ygg marker.",
      });
    }
  }

  private async inspectGitIdentity(
    workspace: Workspace,
    startDirectory: string,
    checks: DoctorCheck[],
  ): Promise<void> {
    let configured: string | null = null;
    try {
      const result = await this.git.run(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        {
          gitDir: workspace.gitDir,
        },
      );
      const actual = await fs.realpath(path.resolve(result.stdout));
      configured = await fs.realpath(workspace.gitDir);
      checks.push(
        actual === configured
          ? {
              id: "git.common-directory",
              status: "pass",
              summary: "Git common-directory identity matches the workspace configuration.",
            }
          : {
              id: "git.common-directory",
              status: "fail",
              summary: "Git common-directory identity does not match the workspace configuration.",
              suggestion: "Run git worktree repair after verifying workspace.yml.",
            },
      );
    } catch (error) {
      checks.push({
        id: "git.common-directory",
        status: "fail",
        summary: `Git common-directory identity could not be verified: ${safeMessage(error)}`,
        suggestion: "Verify the Git directory and run git worktree repair if needed.",
      });
    }

    if (!configured) {
      checks.push({
        id: "git.invocation-context",
        status: "skipped",
        summary: "Invocation-context identity requires a valid configured Git directory.",
      });
      return;
    }
    try {
      const result = await this.git.run(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: startDirectory, reject: false },
      );
      if (result.exitCode !== 0) {
        checks.push({
          id: "git.invocation-context",
          status: "skipped",
          summary: "The invocation directory is not inside a Git worktree.",
        });
        return;
      }
      const actual = await fs.realpath(path.resolve(result.stdout));
      checks.push(
        actual === configured
          ? {
              id: "git.invocation-context",
              status: "pass",
              summary: "The invocation worktree belongs to the configured Git common directory.",
            }
          : {
              id: "git.invocation-context",
              status: "fail",
              summary: "The invocation worktree belongs to a different Git common directory.",
              suggestion: "Run ygg doctor from the intended workspace and verify its .ygg marker.",
            },
      );
    } catch (error) {
      checks.push({
        id: "git.invocation-context",
        status: "fail",
        summary: `Invocation-context identity could not be verified: ${safeMessage(error)}`,
      });
    }
  }

  private async inspectRemote(workspace: Workspace, checks: DoctorCheck[]): Promise<void> {
    const remote = workspace.config.remote;
    if (!remote) {
      checks.push({
        id: "git.remote",
        status: "skipped",
        summary: "This workspace is configured for local-only operation.",
      });
    } else {
      try {
        const result = await this.git.run(["remote"], { gitDir: workspace.gitDir });
        const remotes = result.stdout.split("\n").filter(Boolean);
        checks.push(
          remotes.includes(remote.name)
            ? {
                id: "git.remote",
                status: "pass",
                summary: `Configured remote ${remote.name} exists.`,
              }
            : {
                id: "git.remote",
                status: "fail",
                summary: `Configured remote ${remote.name} does not exist.`,
                suggestion: "Update workspace.yml or restore the configured Git remote.",
              },
        );
      } catch (error) {
        checks.push({ id: "git.remote", status: "fail", summary: safeMessage(error) });
      }
    }

    try {
      const refs = [
        ...(remote ? [`refs/remotes/${remote.name}/${workspace.config.defaultBranch}`] : []),
        `refs/heads/${workspace.config.defaultBranch}`,
      ];
      let resolved = false;
      for (const reference of refs) {
        if (
          await this.git.succeeds(["rev-parse", "--verify", "--quiet", `${reference}^{commit}`], {
            gitDir: workspace.gitDir,
          })
        ) {
          resolved = true;
          break;
        }
      }
      checks.push(
        resolved
          ? {
              id: "git.default-branch",
              status: "pass",
              summary: `Default branch ${workspace.config.defaultBranch} resolves to a commit.`,
            }
          : {
              id: "git.default-branch",
              status: "fail",
              summary: `Default branch ${workspace.config.defaultBranch} does not resolve to a commit.`,
              suggestion: "Restore the configured local or remote default-branch ref.",
            },
      );
    } catch (error) {
      checks.push({
        id: "git.default-branch",
        status: "fail",
        summary: `Default branch identity could not be verified: ${safeMessage(error)}`,
      });
    }
  }

  private inspectWorktrees(
    workspace: Workspace,
    worktrees: Worktree[],
    checks: DoctorCheck[],
  ): void {
    const unavailable = worktrees.filter((worktree) => worktree.state === "unavailable");
    const stale = worktrees.filter(
      (worktree) => !worktree.locked && (worktree.state === "missing" || worktree.prunable),
    );
    const outside = worktrees.filter(
      (worktree) =>
        worktree.role !== "primary" && !isPathInsideOrEqual(workspace.worktreeDir, worktree.path),
    );
    const pathCount = new Set(worktrees.map((worktree) => worktree.path)).size;
    const branchRefs = worktrees.flatMap((worktree) =>
      worktree.branchRef ? [worktree.branchRef] : [],
    );
    const branchCount = new Set(branchRefs).size;
    if (
      unavailable.length > 0 ||
      outside.length > 0 ||
      pathCount !== worktrees.length ||
      branchCount !== branchRefs.length
    ) {
      checks.push({
        id: "git.worktrees",
        status: "fail",
        summary: `${unavailable.length} unavailable, ${outside.length} outside the configured root, and ${worktrees.length - pathCount + (branchRefs.length - branchCount)} duplicate worktree registrations were found.`,
        suggestion: "Inspect the registrations and run git worktree repair where appropriate.",
      });
    } else if (stale.length > 0) {
      checks.push({
        id: "git.worktrees",
        status: "warning",
        summary: `${stale.length} missing or prunable worktree registrations were found.`,
        suggestion: "Preview safe cleanup with ygg prune.",
      });
    } else {
      checks.push({
        id: "git.worktrees",
        status: "pass",
        summary: `${worktrees.length} Git worktree registrations are consistent.`,
      });
    }
    const locked = worktrees.filter((worktree) => worktree.locked);
    checks.push({
      id: "git.worktree-locks",
      status: "pass",
      summary:
        locked.length === 0
          ? "No worktrees are intentionally locked."
          : `${locked.length} worktree ${locked.length === 1 ? "is" : "are"} intentionally locked.`,
      ...(locked.length === 0
        ? {
            suggestion: "Use git worktree lock for worktrees on removable or intermittent storage.",
          }
        : {}),
    });
  }

  private async inspectProject(
    workspace: Workspace,
    worktrees: Worktree[],
    checks: DoctorCheck[],
  ): Promise<void> {
    let project: ProjectConfigDocument | null;
    const current = await this.worktrees.currentFromList(worktrees).catch(() => null);
    try {
      project = await this.configs.resolveEffectiveProjectConfig(
        this.git,
        workspace,
        current,
        worktrees,
      );
    } catch {
      checks.push({
        id: "project.configuration",
        status: "fail",
        summary: "Repository or workspace-local project configuration validation failed.",
        suggestion: "Repair .ygg.yml or the workspace-local project.yml.",
      });
      return;
    }
    if (!project) {
      checks.push({
        id: "project.configuration",
        status: "skipped",
        summary: "No repository or workspace-local project configuration is active.",
      });
      return;
    }
    checks.push({
      id: "project.configuration",
      status: "pass",
      summary: "Repository and workspace-local project configuration are valid.",
    });
    checks.push(
      project.requiresTrust && !this.configs.isTrusted(workspace, project)
        ? {
            id: "project.trust",
            status: "warning",
            summary: "Executable project configuration is not trusted.",
            suggestion: "Review it, then run ygg config trust --yes if it is safe.",
          }
        : {
            id: "project.trust",
            status: "pass",
            summary: project.requiresTrust
              ? "Executable project configuration is trusted."
              : "The active project configuration does not require trust.",
          },
    );
    await this.inspectExecutables(project, current, checks);
    await this.inspectFileSources(workspace, project, current, worktrees, checks);
  }

  private async inspectExecutables(
    project: ProjectConfigDocument,
    current: Worktree | null,
    checks: DoctorCheck[],
  ): Promise<void> {
    const commands = configuredCommands(project);
    const defaultTool = project.config.defaults.tool;
    let missingDefaultProfile = false;
    if (defaultTool) {
      const profile = this.tools.profiles(project)[defaultTool];
      if (profile) commands.push(profile.command[0] as string);
      else missingDefaultProfile = true;
    }
    for (const profile of Object.values(project.config.tools)) {
      commands.push(profile.command[0] as string);
    }
    const unique = [...new Set(commands)];
    const missing: string[] = [];
    for (const command of unique) {
      const expanded = current ? command.replaceAll("{path}", current.path) : command;
      if (!(await commandExists(expanded, current?.path))) missing.push(command);
    }
    checks.push(
      missing.length === 0 && !missingDefaultProfile
        ? {
            id: "project.executables",
            status: "pass",
            summary: `${unique.length} configured argv or tool executables are available.`,
          }
        : {
            id: "project.executables",
            status: "warning",
            summary: `${missing.length} configured executables are unavailable${missingDefaultProfile ? "; the default tool profile is not defined" : ""}.`,
            suggestion: "Install the missing commands or update the project configuration.",
          },
    );
  }

  private async inspectFileSources(
    workspace: Workspace,
    project: ProjectConfigDocument,
    current: Worktree | null,
    worktrees: Worktree[],
    checks: DoctorCheck[],
  ): Promise<void> {
    const steps = configuredSteps(project).filter(
      (step): step is Extract<AutomationStep, { type: "copy" | "symlink" }> =>
        step.type === "copy" || step.type === "symlink",
    );
    const roots: Record<StepSource, string | null> = {
      current: current?.path ?? null,
      default:
        worktrees.find((worktree) => worktree.branch === workspace.config.defaultBranch)?.path ??
        null,
      primary: worktrees.find((worktree) => worktree.role === "primary")?.path ?? null,
      shared: workspace.sharedDir,
    };
    let missingRequired = 0;
    let missingOptional = 0;
    for (const step of steps) {
      const root = roots[step.source];
      if (!root) {
        if (step.optional) missingOptional += 1;
        else missingRequired += 1;
        continue;
      }
      const source = path.resolve(root, step.from);
      let exists = false;
      try {
        exists = isPathInsideOrEqual(root, source) && (await pathExists(source));
      } catch {
        exists = false;
      }
      if (!exists) {
        if (step.optional) missingOptional += 1;
        else missingRequired += 1;
      }
    }
    if (missingRequired > 0) {
      checks.push({
        id: "project.file-sources",
        status: "fail",
        summary: `${missingRequired} required file-step sources are unavailable; ${missingOptional} optional sources are unavailable.`,
        suggestion: "Restore the source files or update the configured file steps.",
      });
    } else if (missingOptional > 0) {
      checks.push({
        id: "project.file-sources",
        status: "warning",
        summary: `${missingOptional} optional file-step sources are unavailable.`,
      });
    } else {
      checks.push({
        id: "project.file-sources",
        status: "pass",
        summary: `${steps.length} configured file-step sources are available.`,
      });
    }
  }
}

async function directoryCheck(
  id: string,
  label: string,
  target: string,
  required: boolean,
  suggestion?: string,
): Promise<DoctorCheck> {
  try {
    const stat = await fs.lstat(target);
    await fs.access(target, fsConstants.R_OK | fsConstants.X_OK);
    const real = await fs.realpath(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return {
        id,
        status: "fail",
        summary: `${label} is not a canonical directory: ${target}.`,
        suggestion,
      };
    }
    return {
      id,
      status: "pass",
      summary: `${label} exists and resolves canonically to ${real}.`,
    };
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return {
      id,
      status: required || !missing ? "fail" : "warning",
      summary: `${label} is unavailable: ${target} (${safeMessage(error)}).`,
      suggestion,
    };
  }
}

function configuredSteps(project: ProjectConfigDocument): AutomationStep[] {
  return [
    ...Object.values(project.config.hooks).flat(),
    ...Object.values(project.config.tasks).flatMap((task) => task.steps),
  ];
}

function configuredCommands(project: ProjectConfigDocument): string[] {
  return configuredSteps(project).flatMap((step) =>
    step.type === "command" && step.argv ? [step.argv[0] as string] : [],
  );
}

function safeMessage(error: unknown): string {
  const withoutUrls = redactSensitiveText(toErrorMessage(error))
    .replace(/\b(?:file|git|https?|ssh):\/\/[^\s]+/giu, "<redacted-url>")
    .replace(/\b[^\s@]+@[^\s:]+:[^\s]+/gu, "<redacted-url>");
  return sanitizeTerminalText(withoutUrls, { multiline: true });
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)(?:\.(\d+))?/u);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart !== minimumPart) return actualPart > minimumPart;
  }
  return true;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function report(checks: DoctorCheck[]): DoctorReport {
  const status = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "pass";
  return { status, checks };
}
