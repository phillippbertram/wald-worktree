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
  sharedDir: string;
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

export type WorktreeTracking =
  | {
      state: "tracked";
      upstream: string;
      ahead: number;
      behind: number;
    }
  | {
      state: "gone";
      upstream: string;
      ahead: null;
      behind: null;
    }
  | {
      state: "none";
      upstream: null;
      ahead: null;
      behind: null;
    }
  | {
      state: "not-applicable";
      upstream: null;
      ahead: null;
      behind: null;
    };

export type WorkspaceStatus = {
  workspace: {
    root: string;
    defaultBranch: string;
  };
  current: {
    name: string;
    path: string;
    branch: string | null;
    role: Worktree["role"];
    state: WorktreeState;
    head: string | null;
    tracking: WorktreeTracking;
  } | null;
  project: {
    path: string;
    sources: ProjectConfigDocument["sources"];
    trust: "not-required" | "trusted" | "untrusted";
  } | null;
  worktrees: Record<WorktreeState, number> & {
    total: number;
  };
};

export type StepSource = "current" | "default" | "primary" | "shared";
export type StepWorkingDirectory = "source" | "target" | "workspace";
export type ExistingTargetPolicy = "error" | "skip" | "replace";

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
  glob?: string;
  to: string;
  optional: boolean;
  onExisting: ExistingTargetPolicy;
};

export type SymlinkStep = StepBase & {
  type: "symlink";
  source: StepSource;
  from: string;
  glob?: string;
  to: string;
  optional: boolean;
  onExisting: ExistingTargetPolicy;
};

export type AutomationStep = CommandStep | CopyStep | SymlinkStep;
export const hookEvents = ["pre_create", "post_create", "pre_remove", "post_remove"] as const;
export type HookEvent = (typeof hookEvents)[number];

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

export type ProjectConfigOverlay = {
  version: 1;
  defaults?: {
    fetch?: boolean;
    tool?: string | null;
  };
  hooks?: Partial<Record<HookEvent, AutomationStep[]>>;
  tasks?: Record<string, ProjectTask | null>;
  tools?: Record<string, ToolProfile | null>;
};

export type ProjectConfigDocument = {
  config: ProjectConfig;
  hash: string;
  path: string;
  sources: {
    repository: string | null;
    workspace: string | null;
  };
  requiresTrust: boolean;
};
