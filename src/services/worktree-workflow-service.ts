import { toErrorMessage, YggError } from "../domain/errors.js";
import type { HookEvent, ProjectConfigDocument, Workspace, Worktree } from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";
import { type AutomationContext, AutomationService } from "./automation-service.js";
import { ConfigService } from "./config-service.js";
import type {
  AddWorktreeOptions,
  PreparedAddWorktree,
  RemovalInspection,
  WorktreeService,
} from "./worktree-service.js";
import {
  WorktreeTransferError,
  WorktreeTransferService,
  type WorktreeTransferSnapshot,
  type WorktreeTransferSummary,
} from "./worktree-transfer-service.js";

type WorktreeContext = {
  current: Worktree | null;
  defaultWorktree: Worktree | null;
  primary: Worktree | null;
};

export type CreatePlan = WorktreeContext & {
  workspace: Workspace;
  prepared: PreparedAddWorktree;
  project: ProjectConfigDocument | null;
  trusted: boolean;
  carrySource: Worktree | null;
};

export type CreatedWorktree = Worktree & {
  carry?: {
    sourcePath: string;
    summary: WorktreeTransferSummary;
  };
};

export type CreateWorktreeOptions = AddWorktreeOptions & {
  carry?: boolean;
};

export type RemovePlan = WorktreeContext & {
  workspace: Workspace;
  inspection: RemovalInspection;
  project: ProjectConfigDocument | null;
  trusted: boolean;
};

export class WorktreeWorkflowService {
  constructor(
    private readonly git: GitClient,
    private readonly worktrees: WorktreeService,
    private readonly configs = new ConfigService(),
    private readonly automation = new AutomationService(),
    private readonly transfers = new WorktreeTransferService(git),
  ) {}

  async planCreate(workspace: Workspace, options: CreateWorktreeOptions): Promise<CreatePlan> {
    const context = await this.readWorktreeContext(workspace);
    const sourceDocument = await this.readSourceProjectConfig(workspace, context);
    if (options.carry && options.from) {
      throw new YggError(
        "Cannot combine carry with an explicit base; carry always starts at HEAD.",
      );
    }
    if (options.carry && !context.current) {
      throw new YggError("Run ygg create --carry from inside the source worktree.");
    }
    const from = await this.resolveRequestedBase(
      options.carry ? "HEAD" : options.from,
      context.current,
    );
    const prepared = await this.worktrees.prepareAdd(workspace, {
      ...options,
      from,
      newBranchOnly: options.carry,
      fetch: options.fetch ?? sourceDocument?.config.defaults.fetch ?? true,
    });
    const project = options.carry
      ? sourceDocument
      : await this.configs.resolveProjectConfigAtRevision(
          this.git,
          workspace,
          prepared.projectRevision,
        );
    return {
      workspace,
      prepared,
      project,
      trusted: this.configs.isTrusted(workspace, project),
      carrySource: options.carry ? context.current : null,
      ...context,
    };
  }

  async executeCreate(
    plan: CreatePlan,
    options: {
      trustProjectConfig?: boolean;
      output?: NodeJS.WritableStream;
    } = {},
  ): Promise<CreatedWorktree> {
    await this.ensureTrusted(plan.workspace, plan.project, options.trustProjectConfig);
    const preCreateContext = this.automationContext(
      plan,
      "pre_create",
      plan.prepared.branch,
      plan.prepared.target,
      options.output,
    );
    await this.automation.runHook(plan.project, "pre_create", preCreateContext);

    let snapshot: WorktreeTransferSnapshot | undefined;
    if (plan.carrySource) {
      const sourceProject = await this.configs.resolveProjectConfig(
        plan.workspace,
        plan.carrySource.path,
      );
      if ((sourceProject?.hash ?? null) !== (plan.project?.hash ?? null)) {
        throw new YggError(
          "The effective project configuration changed after pre-create. Review and trust it, then retry the carry.",
        );
      }
      snapshot = await this.transfers.capture(plan.carrySource.path);
      const refreshedSource = await this.worktrees.resolve(plan.workspace, plan.carrySource.path);
      if (
        refreshedSource.path !== plan.carrySource.path ||
        refreshedSource.branchRef !== plan.carrySource.branchRef ||
        refreshedSource.head !== snapshot.head ||
        plan.prepared.strategy.type !== "new" ||
        plan.prepared.strategy.base !== snapshot.head
      ) {
        throw new YggError(
          "The source worktree or its HEAD changed after pre-create. Review it, then retry the carry.",
        );
      }
    }

    const created = await this.worktrees.createPrepared(plan.workspace, plan.prepared);
    let targetProject: ProjectConfigDocument | null;
    try {
      if (snapshot) {
        await this.transfers.apply(snapshot, created.path);
      }
      targetProject = await this.configs.resolveProjectConfig(plan.workspace, created.path);
      if ((plan.project?.hash ?? null) !== (targetProject?.hash ?? null)) {
        throw new YggError(
          `Worktree was created at ${created.path}, but its effective project configuration does not match the configuration inspected before creation. Review the worktree before running hooks.`,
        );
      }
    } catch (error) {
      if (snapshot && error instanceof WorktreeTransferError && error.rollbackSafe) {
        await this.rollbackFailedCarry(plan.workspace, created, snapshot, error);
      }
      if (snapshot) {
        throw new YggError(
          `Carrying local changes failed: ${toErrorMessage(error)}\nThe created worktree and branch were preserved because the target may contain changes. Inspect ${created.path} and branch ${created.branch}; preserve anything useful before manual cleanup.`,
          { cause: error },
        );
      }
      throw error;
    }

    try {
      const postContext: AutomationContext = {
        ...this.automationContext(
          plan,
          "post_create",
          created.branch,
          created.path,
          options.output,
        ),
        defaultWorktree:
          created.branch === plan.workspace.config.defaultBranch ? created : plan.defaultWorktree,
      };
      await this.automation.runHook(targetProject, "post_create", postContext);
    } catch (error) {
      throw new YggError(
        `Worktree was created at ${created.path}, but post-create setup failed: ${toErrorMessage(error)}\nRetry with: ygg setup ${shellQuote(created.name)}`,
        { cause: error },
      );
    }

    return snapshot
      ? {
          ...created,
          carry: {
            sourcePath: snapshot.sourcePath,
            summary: snapshot.summary,
          },
        }
      : created;
  }

  private async rollbackFailedCarry(
    workspace: Workspace,
    created: Worktree,
    snapshot: WorktreeTransferSnapshot,
    error: unknown,
  ): Promise<never> {
    try {
      await this.worktrees.rollbackCreated(workspace, created, snapshot.head);
    } catch (rollbackError) {
      throw new YggError(
        `Carrying local changes failed: ${toErrorMessage(error)}\nAutomatic rollback did not complete: ${toErrorMessage(rollbackError)}\nInspect the target path ${created.path} and branch ${created.branch}; preserve anything useful before manual cleanup.`,
        { cause: error },
      );
    }
    throw new YggError(
      `Carrying local changes failed and the created worktree and branch were rolled back: ${toErrorMessage(error)}`,
      { cause: error },
    );
  }

  async planRemove(workspace: Workspace, identifier: string): Promise<RemovePlan> {
    const [context, inspection] = await Promise.all([
      this.readWorktreeContext(workspace),
      this.worktrees.inspectRemoval(workspace, identifier),
    ]);
    const project = await this.configs.resolveProjectConfig(workspace, inspection.worktree.path);
    return {
      workspace,
      inspection,
      project,
      trusted: this.configs.isTrusted(workspace, project),
      ...context,
    };
  }

  async executeRemove(
    plan: RemovePlan,
    options: { force?: boolean; trustProjectConfig?: boolean; output?: NodeJS.WritableStream } = {},
  ): Promise<void> {
    await this.ensureTrusted(plan.workspace, plan.project, options.trustProjectConfig);
    const context = this.automationContext(
      plan,
      "pre_remove",
      plan.inspection.worktree.branch,
      plan.inspection.worktree.path,
      options.output,
    );
    await this.automation.runHook(plan.project, "pre_remove", context);
    await this.worktrees.remove(plan.workspace, plan.inspection.worktree, Boolean(options.force));
    try {
      await this.automation.runHook(plan.project, "post_remove", {
        ...context,
        event: "post_remove",
      });
    } catch (error) {
      throw new YggError(
        `Worktree ${plan.inspection.worktree.name} was removed, but its post-remove hook failed: ${toErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async runTask(
    workspace: Workspace,
    worktree: Worktree,
    name: string,
    options: { trustProjectConfig?: boolean; output?: NodeJS.WritableStream } = {},
  ): Promise<void> {
    const [project, context] = await Promise.all([
      this.configs.resolveProjectConfig(workspace, worktree.path),
      this.readWorktreeContext(workspace),
    ]);
    if (!project) {
      throw new YggError(`No project configuration found for ${worktree.path}`);
    }
    await this.ensureTrusted(workspace, project, options.trustProjectConfig);
    await this.automation.runTask(project, name, {
      ...context,
      workspace,
      event: `task:${name}`,
      branch: worktree.branch,
      targetPath: worktree.path,
      current: worktree,
      output: options.output,
    });
  }

  async runHook(
    workspace: Workspace,
    worktree: Worktree,
    event: HookEvent,
    options: { trustProjectConfig?: boolean; output?: NodeJS.WritableStream } = {},
  ): Promise<void> {
    const [project, context] = await Promise.all([
      this.configs.resolveProjectConfig(workspace, worktree.path),
      this.readWorktreeContext(workspace),
    ]);
    await this.ensureTrusted(workspace, project, options.trustProjectConfig);
    await this.automation.runHook(project, event, {
      ...context,
      workspace,
      event,
      branch: worktree.branch,
      targetPath: worktree.path,
      current: worktree,
      output: options.output,
    });
  }

  async projectForWorktree(
    workspace: Workspace,
    worktree: Worktree,
  ): Promise<ProjectConfigDocument | null> {
    return await this.configs.resolveProjectConfig(workspace, worktree.path);
  }

  async trust(workspace: Workspace, project: ProjectConfigDocument): Promise<void> {
    await this.configs.trust(workspace, project);
  }

  private async readWorktreeContext(workspace: Workspace): Promise<WorktreeContext> {
    const all = await this.worktrees.list(workspace);
    const currentPath = await this.worktrees.current(workspace);
    return {
      current: currentPath,
      defaultWorktree:
        all.find((worktree) => worktree.branch === workspace.config.defaultBranch) ?? null,
      primary: all.find((worktree) => worktree.role === "primary") ?? null,
    };
  }

  private async readSourceProjectConfig(
    workspace: Workspace,
    context: WorktreeContext,
  ): Promise<ProjectConfigDocument | null> {
    const source = context.current ?? context.defaultWorktree ?? context.primary;
    if (source) {
      return await this.configs.resolveProjectConfig(workspace, source.path);
    }
    const revision = workspace.config.remote
      ? `${workspace.config.remote.name}/${workspace.config.defaultBranch}`
      : workspace.config.defaultBranch;
    return await this.configs.resolveProjectConfigAtRevision(this.git, workspace, revision);
  }

  private async resolveRequestedBase(
    requestedBase: string | undefined,
    current: Worktree | null,
  ): Promise<string | undefined> {
    if (requestedBase !== "HEAD" || !current) {
      return requestedBase;
    }
    const result = await this.git.run(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: current.path,
    });
    return result.stdout;
  }

  private async ensureTrusted(
    workspace: Workspace,
    project: ProjectConfigDocument | null,
    trustProjectConfig?: boolean,
  ): Promise<void> {
    if (this.configs.isTrusted(workspace, project)) {
      return;
    }
    if (trustProjectConfig && project) {
      await this.configs.trust(workspace, project);
      return;
    }
    throw new YggError(
      `Project configuration is not trusted: ${project?.path ?? "effective configuration"}\nReview it, then run: ygg config trust`,
    );
  }

  private automationContext(
    plan: CreatePlan | RemovePlan,
    event: HookEvent,
    branch: string | null,
    targetPath: string,
    output?: NodeJS.WritableStream,
  ): AutomationContext {
    return {
      workspace: plan.workspace,
      event,
      branch,
      targetPath,
      current: plan.current,
      defaultWorktree: plan.defaultWorktree,
      primary: plan.primary,
      output,
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
