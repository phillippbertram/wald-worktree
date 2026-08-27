import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  initializationPreviewSummary,
  renderInitializationPreview,
  type WorkspaceInitializationPreview,
} from "../src/cli/init-preview.js";
import type {
  AdoptionInspection,
  ManagedInitializationPlan,
} from "../src/services/workspace-service.js";

describe("workspace initialization preview", () => {
  it("renders an absolute flat managed layout without a fake worktrees directory", () => {
    const preview = managedPreview("/projects/my-app", "/projects/my-app");

    const rendered = renderInitializationPreview(preview);

    expect(rendered).toContain("/projects/my-app/  new: workspace root");
    expect(rendered).toContain("├── .ygg/  new: local Ygg metadata");
    expect(rendered).toContain("└── repo.git/  new: shared Git database");
    expect(rendered).toContain("New worktrees: /projects/my-app/<branch>  optional next");
    expect(rendered).not.toContain("worktrees/  new: future worktrees");
  });

  it("renders a grouped managed layout and its concrete absolute paths", () => {
    const preview = managedPreview("/projects/my-app", "/projects/my-app/worktrees");

    const rendered = renderInitializationPreview(preview);

    expect(rendered).toContain("└── worktrees/  new: future worktrees");
    expect(initializationPreviewSummary(preview)).toContainEqual([
      "New worktrees",
      "/projects/my-app/worktrees",
    ]);
  });

  it("renders a retained checkout, metadata, and worktree marker in one tree", () => {
    const preview: WorkspaceInitializationPreview = {
      mode: "adopt",
      inspection: adoptionInspection(false),
      worktreeDirExisted: false,
    };

    const rendered = renderInitializationPreview(preview);

    expect(rendered).toContain("/projects/");
    expect(rendered).toContain("├── app/  existing: primary checkout");
    expect(rendered).toContain("│   └── .git/");
    expect(rendered).toContain("│       └── ygg/  new: local Ygg metadata");
    expect(rendered).toContain("└── app-worktrees/  new: future worktree container");
    expect(rendered).toContain(".ygg -> /projects/app/.git/ygg  new: metadata link");
  });

  it("uses bare-repository wording and marks an existing worktree container", () => {
    const preview: WorkspaceInitializationPreview = {
      mode: "adopt",
      inspection: adoptionInspection(true),
      worktreeDirExisted: true,
    };

    const rendered = renderInitializationPreview(preview);

    expect(rendered).toContain("repo.git/  existing: bare Git repository");
    expect(rendered).toContain("trees/  existing: worktree container");
    expect(initializationPreviewSummary(preview)).toContainEqual([
      "Repository type",
      "bare repository",
    ]);
  });

  it("renders separate absolute trees when repository and worktree paths share only the root", () => {
    const inspection = adoptionInspection(false);
    inspection.worktreeDir = "/elsewhere/app-worktrees";
    const preview: WorkspaceInitializationPreview = {
      mode: "adopt",
      inspection,
      worktreeDirExisted: false,
    };

    const rendered = renderInitializationPreview(preview);

    expect(rendered).toContain("/projects/app/  existing: primary checkout");
    expect(rendered).toContain("/elsewhere/app-worktrees/  new: future worktree container");
    expect(rendered.split("\n")).not.toContain(path.parse("/projects/app").root);
  });
});

function managedPreview(root: string, worktreeDir: string): WorkspaceInitializationPreview {
  const target: ManagedInitializationPlan = {
    root,
    gitDir: path.join(root, "repo.git"),
    metadataDir: path.join(root, ".ygg"),
    sharedDir: path.join(root, ".ygg", "shared"),
    worktreeDir,
    configPath: path.join(root, ".ygg", "workspace.yml"),
    rootExisted: false,
  };
  return {
    mode: "remote",
    source: "git@example.invalid:team/my-app.git",
    target,
    remoteName: "origin",
    defaultBranch: null,
  };
}

function adoptionInspection(bare: boolean): AdoptionInspection {
  const source = bare ? "/projects/repo.git" : "/projects/app";
  const gitDir = bare ? source : path.join(source, ".git");
  return {
    source,
    gitDir,
    bare,
    primaryWorktree: bare ? null : source,
    worktrees: [],
    remotes: ["origin"],
    remoteName: "origin",
    remoteSelectionRequired: false,
    defaultBranch: "main",
    defaultBranchCandidates: ["main"],
    worktreeDir: bare ? "/projects/trees" : "/projects/app-worktrees",
    worktreeDirSelectionRequired: false,
    metadataDir: path.join(gitDir, "ygg"),
    existingWorkspace: null,
    modified: false,
    modifiedWorktrees: [],
    detachedWorktrees: [],
    stashCount: 0,
  };
}
