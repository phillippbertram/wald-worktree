export type WorkspaceMode = "managed" | "adopted";

export type WorkspaceRemote = {
  name: string;
  fetchRefspec: string;
};

export type WorkspaceConfig = {
  schemaVersion: 2;
  mode: WorkspaceMode;
  gitDir: string;
  envDir: string;
  worktreeDir: string;
  remote: WorkspaceRemote | null;
  defaultBranch: string;
  primaryWorktree: string | null;
};

export type Workspace = {
  root: string;
  configPath: string;
  gitDir: string;
  envDir: string;
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

export type EnvironmentState = "linked" | "missing" | "conflict" | "wrong-link";

export type EnvironmentFileStatus = {
  path: string;
  state: EnvironmentState;
  target: string;
};

export type EnvironmentSyncResult = {
  worktree: Worktree;
  created: string[];
  repaired: string[];
  linked: string[];
  conflicts: EnvironmentFileStatus[];
};

export type EnvironmentImportCandidate = {
  path: string;
  source: string;
  target: string;
  state: "new" | "same" | "conflict" | "already-linked";
};

export type EnvironmentImportResult = {
  worktree: Worktree;
  imported: string[];
  linked: string[];
  skipped: string[];
  conflicts: string[];
};
