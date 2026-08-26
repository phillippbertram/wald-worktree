export type WorkspaceMode = "managed" | "adopted";

export type WorkspaceRemote = {
  name: string;
  fetchRefspec: string;
};

export type WorkspaceConfig = {
  version: 1;
  mode: WorkspaceMode;
  paths: {
    git: string;
    worktrees: string;
    primaryWorktree: string | null;
  };
  remote: WorkspaceRemote | null;
  defaultBranch: string;
  trustedProjectConfig: string | null;
};

export type Workspace = {
  root: string;
  configPath: string;
  gitDir: string;
  worktreeDir: string;
  primaryWorktree: string | null;
  config: WorkspaceConfig;
};

export type WorktreeState = "clean" | "modified" | "locked" | "missing";

export type Worktree = {
  name: string;
  role: "primary" | "linked";
  path: string;
  head: string | null;
  branch: string | null;
  branchRef: string | null;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  state: WorktreeState;
};

export type StepSource = "current" | "default" | "primary";
export type StepWorkingDirectory = "source" | "target" | "workspace";

type StepBase = {
  continueOnError: boolean;
};

export type CommandStep = StepBase & {
  type: "command";
  argv?: string[];
  shell?: string;
  cwd?: StepWorkingDirectory;
  env: Record<string, string>;
  timeoutSeconds?: number;
};

export type CopyStep = StepBase & {
  type: "copy";
  source: StepSource;
  from: string;
  to: string;
  optional: boolean;
  overwrite: boolean;
};

export type SymlinkStep = StepBase & {
  type: "symlink";
  source: StepSource;
  from: string;
  to: string;
  optional: boolean;
  overwrite: boolean;
};

export type AutomationStep = CommandStep | CopyStep | SymlinkStep;
export type HookEvent = "pre_create" | "post_create" | "pre_remove" | "post_remove";

export type ProjectTask = {
  description?: string;
  steps: AutomationStep[];
};

export type ToolProfile = {
  description?: string;
  command: string[];
  mode: "foreground" | "detached";
};

export type ProjectConfig = {
  version: 1;
  defaults: {
    fetch: boolean;
    tool?: string;
  };
  hooks: Record<HookEvent, AutomationStep[]>;
  tasks: Record<string, ProjectTask>;
  tools: Record<string, ToolProfile>;
};

export type ProjectConfigDocument = {
  config: ProjectConfig;
  hash: string;
  path: string;
  requiresTrust: boolean;
};
