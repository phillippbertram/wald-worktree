import path from "node:path";
import type {
  AdoptionInspection,
  ManagedInitializationPlan,
} from "../services/workspace-service.js";
import { style } from "../ui/style.js";

export type ManagedWorkspacePreview = {
  mode: "remote" | "copy";
  source: string;
  target: ManagedInitializationPlan;
  remoteName: string | null;
  defaultBranch: string | null;
  modifiedWorktrees?: string[];
  detachedWorktrees?: string[];
  stashCount?: number;
};

export type AdoptedWorkspacePreview = {
  mode: "adopt";
  inspection: AdoptionInspection;
  worktreeDirExisted: boolean;
};

export type WorkspaceInitializationPreview = ManagedWorkspacePreview | AdoptedWorkspacePreview;

type PlannedPath = {
  target: string;
  kind: "directory" | "file" | "symlink";
  annotation?: string;
  label?: string;
};

type TreeNode = {
  name: string;
  kind: PlannedPath["kind"];
  annotation?: string;
  label?: string;
  children: Map<string, TreeNode>;
};

export function initializationPreviewSummary(
  preview: WorkspaceInitializationPreview,
): Array<[string, string]> {
  if (preview.mode === "adopt") {
    const { inspection } = preview;
    return [
      ["Source repository", inspection.primaryWorktree ?? inspection.gitDir],
      ["Repository type", inspection.bare ? "bare repository" : "working checkout"],
      ["Layout", "Retained existing checkout"],
      ["Primary checkout", inspection.primaryWorktree ?? "none"],
      ["Ygg metadata", inspection.metadataDir],
      ["New worktrees", inspection.worktreeDir],
      ["Remote", inspection.remoteName ?? "none (local only)"],
      ["Default branch", inspection.defaultBranch ?? "unresolved"],
      ["Existing Git configuration", "unchanged"],
      ["Uncommitted changes", inspection.modifiedWorktrees.length > 0 ? "kept" : "none detected"],
      ["Stashes", inspection.stashCount > 0 ? `${inspection.stashCount} kept` : "none detected"],
    ];
  }

  const rows: Array<[string, string]> = [
    ["Source repository", preview.source],
    ["Workspace root", preview.target.root],
    [
      "Layout",
      preview.target.worktreeDir === preview.target.root
        ? "Ygg Flow — flat standalone workspace"
        : "Grouped standalone workspace",
    ],
    ["Git database", preview.target.gitDir],
    ["Ygg metadata", preview.target.metadataDir],
    ["New worktrees", preview.target.worktreeDir],
    ["Remote", preview.remoteName ?? "none (local only)"],
    ["Default branch", preview.defaultBranch ?? "detected from the remote during initialization"],
  ];
  if (preview.mode === "copy") {
    rows.push(
      ["Git object storage", "copied independently (no hardlinks)"],
      ["Working-tree and ignored files", "not copied — source remains unchanged"],
      [
        "Modified worktrees",
        preview.modifiedWorktrees && preview.modifiedWorktrees.length > 0
          ? preview.modifiedWorktrees.join(", ")
          : "none detected",
      ],
      [
        "Detached worktrees",
        preview.detachedWorktrees && preview.detachedWorktrees.length > 0
          ? `${preview.detachedWorktrees.length} — commits need a branch to be copied reliably`
          : "none",
      ],
      [
        "Stashes copied",
        preview.stashCount && preview.stashCount > 0
          ? `no — ${preview.stashCount} remain in source`
          : "none",
      ],
    );
  }
  return rows;
}

export function renderInitializationPreview(preview: WorkspaceInitializationPreview): string {
  const tree =
    preview.mode === "adopt" ? renderAdoptedTree(preview) : renderManagedTree(preview.target);
  return [
    tree,
    "",
    "Each worktree has its own files, HEAD, index, dependencies, build output, and processes.",
    "Future worktrees share branches, history, remotes, and stashes within this workspace.",
  ].join("\n");
}

function renderManagedTree(target: ManagedInitializationPlan): string {
  const entries: PlannedPath[] = [
    {
      target: target.root,
      kind: "directory",
      annotation: target.rootExisted ? "existing: empty workspace root" : "new: workspace root",
    },
    {
      target: target.metadataDir,
      kind: "directory",
      annotation: "new: local Ygg metadata",
    },
    { target: target.configPath, kind: "file", annotation: "new: workspace configuration" },
    { target: target.sharedDir, kind: "directory", annotation: "new: local shared files" },
    { target: target.gitDir, kind: "directory", annotation: "new: shared Git database" },
  ];
  if (target.worktreeDir !== target.root) {
    entries.push({
      target: target.worktreeDir,
      kind: "directory",
      annotation: "new: future worktrees",
    });
  }

  const lines = [renderPathTree(target.root, entries)];
  if (target.worktreeDir === target.root) {
    lines.push(
      `${style.label("New worktrees:")} ${style.path(path.join(target.root, "<branch>"))}  optional next`,
    );
  }
  return lines.join("\n\n");
}

function renderAdoptedTree(preview: AdoptedWorkspacePreview): string {
  const { inspection } = preview;
  const sourceRoot = inspection.primaryWorktree ?? inspection.gitDir;
  const entries: PlannedPath[] = [
    {
      target: sourceRoot,
      kind: "directory",
      annotation: inspection.bare ? "existing: bare Git repository" : "existing: primary checkout",
    },
    {
      target: inspection.metadataDir,
      kind: "directory",
      annotation: "new: local Ygg metadata",
    },
    {
      target: path.join(inspection.metadataDir, "workspace.yml"),
      kind: "file",
      annotation: "new: workspace configuration",
    },
    {
      target: path.join(inspection.metadataDir, "shared"),
      kind: "directory",
      annotation: "new: local shared files",
    },
    {
      target: inspection.worktreeDir,
      kind: "directory",
      annotation: preview.worktreeDirExisted
        ? "existing: worktree container"
        : "new: future worktree container",
    },
    {
      target: path.join(inspection.worktreeDir, ".ygg"),
      kind: "symlink",
      label: `.ygg -> ${inspection.metadataDir}`,
      annotation: "new: metadata link",
    },
  ];

  const common = commonAncestor([sourceRoot, inspection.worktreeDir]);
  if (common !== path.parse(common).root) {
    return renderPathTree(common, entries);
  }

  const sourceTreeRoot = isInsideOrEqual(sourceRoot, inspection.metadataDir)
    ? sourceRoot
    : inspection.gitDir;
  const sections = [
    renderPathTree(
      sourceTreeRoot,
      entries.filter((entry) => isInsideOrEqual(sourceTreeRoot, entry.target)),
    ),
  ];
  if (sourceTreeRoot !== sourceRoot) {
    sections.unshift(
      renderPathTree(
        sourceRoot,
        entries.filter((entry) => entry.target === sourceRoot),
      ),
    );
  }
  sections.push(
    renderPathTree(
      inspection.worktreeDir,
      entries.filter((entry) => isInsideOrEqual(inspection.worktreeDir, entry.target)),
    ),
  );
  return sections.join("\n\n");
}

function renderPathTree(rootPath: string, entries: PlannedPath[]): string {
  const rootEntry = entries.find((entry) => path.resolve(entry.target) === path.resolve(rootPath));
  const root: TreeNode = {
    name: path.basename(rootPath) || rootPath,
    kind: "directory",
    annotation: rootEntry?.annotation,
    label: rootEntry?.label ?? `${rootPath}${rootPath.endsWith(path.sep) ? "" : path.sep}`,
    children: new Map(),
  };

  for (const entry of entries) {
    const relative = path.relative(rootPath, entry.target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const segments = relative.split(path.sep).filter(Boolean);
    let current = root;
    for (const [index, segment] of segments.entries()) {
      const final = index === segments.length - 1;
      let child = current.children.get(segment);
      if (!child) {
        child = {
          name: segment,
          kind: final ? entry.kind : "directory",
          children: new Map(),
        };
        current.children.set(segment, child);
      }
      if (final) {
        child.kind = entry.kind;
        child.annotation = entry.annotation;
        child.label = entry.label;
      }
      current = child;
    }
  }

  return [`${formatNode(root)}${formatAnnotation(root.annotation)}`, ...renderChildren(root)].join(
    "\n",
  );
}

function renderChildren(node: TreeNode, prefix = ""): string[] {
  const children = [...node.children.values()];
  return children.flatMap((child, index) => {
    const last = index === children.length - 1;
    const line = `${prefix}${last ? "└──" : "├──"} ${formatNode(child)}${formatAnnotation(child.annotation)}`;
    return [line, ...renderChildren(child, `${prefix}${last ? "    " : "│   "}`)];
  });
}

function formatNode(node: TreeNode): string {
  if (node.label) return style.path(node.label);
  return style.path(node.kind === "directory" ? `${node.name}${path.sep}` : node.name);
}

function formatAnnotation(annotation: string | undefined): string {
  if (!annotation) return "";
  if (annotation.startsWith("new:")) return `  ${style.success("new:")}${annotation.slice(4)}`;
  if (annotation.startsWith("existing:")) {
    return `  ${style.label("existing:")}${annotation.slice(9)}`;
  }
  return `  ${annotation}`;
}

function commonAncestor(paths: string[]): string {
  let candidate = path.resolve(paths[0] as string);
  for (const item of paths.slice(1)) {
    const target = path.resolve(item);
    while (!isInsideOrEqual(candidate, target)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) return candidate;
      candidate = parent;
    }
  }
  return candidate;
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
