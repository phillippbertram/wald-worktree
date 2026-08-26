import { GitClient } from "../infrastructure/git-client.js";
import { ProcessRunner } from "../infrastructure/process-runner.js";
import { ConfigService } from "../services/config-service.js";
import { ShellService } from "../services/shell-service.js";
import { ToolService } from "../services/tool-service.js";
import { WorkspaceService } from "../services/workspace-service.js";
import { WorktreeService } from "../services/worktree-service.js";
import { WorktreeWorkflowService } from "../services/worktree-workflow-service.js";

export type CliOutput = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type CliContext = ReturnType<typeof createCliContext>;

export function createCliContext(
  output: CliOutput = { stdout: process.stdout, stderr: process.stderr },
) {
  const git = new GitClient();
  const configs = new ConfigService();
  const workspaces = new WorkspaceService(git, configs);
  const worktrees = new WorktreeService(git);
  const processes = new ProcessRunner();
  return {
    output,
    git,
    configs,
    workspaces,
    worktrees,
    processes,
    workflow: new WorktreeWorkflowService(git, worktrees, configs),
    tools: new ToolService(processes),
    shells: new ShellService(),
  };
}
