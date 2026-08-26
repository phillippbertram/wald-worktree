import { toErrorMessage, WtError } from "../domain/errors.js";
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
  ) {}

  async planCreate(workspace: Workspace, options: AddWorktreeOptions): Promise<CreatePlan> {
    const context = await this.readWorktreeContext(workspace);
    const sourceDocument = await this.readSourceProjectConfig(workspace, context);
    const prepared = await this.worktrees.prepareAdd(workspace, {
      ...options,
      fetch: options.fetch ?? sourceDocument?.config.defaults.fetch ?? true,
    });
    const project = await this.configs.readProjectConfigAtRevision(
      this.git,
      workspace,
      prepared.projectRevision,
    );
    return {
      workspace,
      prepared,
      project,
      trusted: this.configs.isTrusted(workspace, project),
      ...context,
    };
  }

  async executeCreate(
    plan: CreatePlan,
    options: {
      trustProjectConfig?: boolean;
      output?: NodeJS.WritableStream;
    } = {},
  ): Promise<Worktree> {
    await this.ensureTrusted(plan.workspace, plan.project, options.trustProjectConfig);
    const preCreateContext = this.automationContext(
      plan,
      "pre_create",
      plan.prepared.branch,
      plan.prepared.target,
      options.output,
    );
    await this.automation.runHook(plan.project, "pre_create", preCreateContext);

    const created = await this.worktrees.createPrepared(plan.workspace, plan.prepared);
    const targetProject = await this.configs.readProjectConfig(created.path);
    if ((plan.project?.hash ?? null) !== (targetProject?.hash ?? null)) {
      throw new WtError(
        `Worktree was created at ${created.path}, but its ${targetProject?.path ?? ".wt.yml"} does not match the configuration inspected before creation. Review the worktree before running hooks.`,
      );
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
      throw new WtError(
        `Worktree was created at ${created.path}, but post-create setup failed: ${toErrorMessage(error)}\nRetry with: wt setup ${shellQuote(created.name)}`,
        { cause: error },
      );
    }

    return created;
  }

  async planRemove(workspace: Workspace, identifier: string): Promise<RemovePlan> {
    const [context, inspection] = await Promise.all([
      this.readWorktreeContext(workspace),
      this.worktrees.inspectRemoval(workspace, identifier),
    ]);
    const project = await this.configs.readProjectConfig(inspection.worktree.path);
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
      throw new WtError(
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
      this.configs.readProjectConfig(worktree.path),
      this.readWorktreeContext(workspace),
    ]);
    if (!project) {
      throw new WtError(`No .wt.yml found in ${worktree.path}`);
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
      this.configs.readProjectConfig(worktree.path),
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

  async projectForWorktree(worktree: Worktree): Promise<ProjectConfigDocument | null> {
    return await this.configs.readProjectConfig(worktree.path);
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
      return await this.configs.readProjectConfig(source.path);
    }
    const revision = workspace.config.remote
      ? `${workspace.config.remote.name}/${workspace.config.defaultBranch}`
      : workspace.config.defaultBranch;
    return await this.configs.readProjectConfigAtRevision(this.git, workspace, revision);
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
    throw new WtError(
      `Project configuration is not trusted: ${project?.path ?? ".wt.yml"}\nReview it, then run: wt config trust`,
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
