import { GitClient } from "../infrastructure/git-client.js";
import { ProcessRunner } from "../infrastructure/process-runner.js";
import { AutomationService } from "../services/automation-service.js";
import { ConfigService } from "../services/config-service.js";
import { DoctorService } from "../services/doctor-service.js";
import { ProjectConfigInitializer } from "../services/project-config-initializer.js";
import { ShellService } from "../services/shell-service.js";
import { ToolService } from "../services/tool-service.js";
import { WorkspaceService } from "../services/workspace-service.js";
import { WorkspaceStatusService } from "../services/workspace-status-service.js";
import { WorktreeService } from "../services/worktree-service.js";
import { WorktreeWorkflowService } from "../services/worktree-workflow-service.js";
import { createAutomationReporter } from "../ui/automation-reporter.js";

export type CliOutput = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type CliExecutionState = {
  json: boolean;
};

export function createCliExecutionState(): CliExecutionState {
  return { json: false };
}

export type CliContext = ReturnType<typeof createCliContext>;

export function createCliContext(
  output: CliOutput = { stdout: process.stdout, stderr: process.stderr },
  execution: CliExecutionState = createCliExecutionState(),
) {
  const git = new GitClient();
  const configs = new ConfigService();
  const workspaces = new WorkspaceService(git, configs);
  const worktrees = new WorktreeService(git);
  const processes = new ProcessRunner();
  const automation = new AutomationService(processes, createAutomationReporter);
  const tools = new ToolService(processes);
  return {
    output,
    execution,
    git,
    configs,
    projectConfigs: new ProjectConfigInitializer(),
    workspaces,
    worktrees,
    status: new WorkspaceStatusService(git, worktrees, configs),
    doctor: new DoctorService(git, workspaces, worktrees, configs, tools),
    processes,
    workflow: new WorktreeWorkflowService(git, worktrees, configs, automation),
    tools,
    shells: new ShellService(),
  };
}
