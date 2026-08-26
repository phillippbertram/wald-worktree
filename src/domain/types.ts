export type WorkspaceConfig = {
  schemaVersion: 1;
  gitDir: string;
  envDir: string;
  remote: string;
  defaultBranch: string;
};

export type Workspace = {
  root: string;
  configPath: string;
  gitDir: string;
  envDir: string;
  config: WorkspaceConfig;
};

export type WorktreeState = "clean" | "modified" | "locked" | "missing";

export type Worktree = {
  name: string;
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
