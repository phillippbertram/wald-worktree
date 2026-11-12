import pc from "picocolors";
import type { WorkspaceStatus, WorktreeTracking } from "../domain/types.js";
import { style } from "./style.js";

const labelWidth = "Worktrees".length;
const separator = pc.dim("·");

export function printWorkspaceStatus(status: WorkspaceStatus, stream: NodeJS.WritableStream): void {
  writeStatusRow(
    stream,
    "Workspace",
    `${style.path(status.workspace.root)} ${separator} default ${style.branch(status.workspace.defaultBranch)}`,
  );
  writeStatusRow(stream, "Current", renderCurrent(status));
  writeStatusRow(stream, "Tracking", renderTracking(status.current?.tracking));
  writeStatusRow(stream, "Project", renderProject(status));
  writeStatusRow(stream, "Worktrees", renderWorktreeCounts(status));
}

function writeStatusRow(stream: NodeJS.WritableStream, label: string, value: string): void {
  stream.write(`${style.label(label.padEnd(labelWidth))}  ${value}\n`);
}

function renderCurrent(status: WorkspaceStatus): string {
  const current = status.current;
  if (!current) return "workspace root";
  return [
    style.worktree(current.name),
    style.branch(current.branch ?? "detached"),
    current.role,
    style.state(current.state, current.state),
  ].join(` ${separator} `);
}

function renderTracking(tracking: WorktreeTracking | undefined): string {
  if (!tracking || tracking.state === "not-applicable") return "not applicable";
  if (tracking.state === "none") return "none";
  if (tracking.state === "gone") {
    return `${style.branch(tracking.upstream)} ${separator} ${style.warning("unavailable locally")}`;
  }
  return [
    style.branch(tracking.upstream),
    `ahead ${style.value(tracking.ahead)}`,
    `behind ${style.value(tracking.behind)}`,
    pc.dim("local refs"),
  ].join(` ${separator} `);
}

function renderProject(status: WorkspaceStatus): string {
  const project = status.project;
  if (!project) return "none";
  const trust =
    project.trust === "untrusted" ? style.warning(project.trust) : style.success(project.trust);
  return `${style.path(project.path)} ${separator} ${trust}`;
}

function renderWorktreeCounts(status: WorkspaceStatus): string {
  const counts = status.worktrees;
  return [
    `${style.value(counts.total)} total`,
    style.state(`${counts.clean} clean`, "clean"),
    style.state(`${counts.modified} modified`, "modified"),
    style.state(`${counts.locked} locked`, "locked"),
    style.state(`${counts.missing} missing`, "missing"),
    style.state(`${counts.unavailable} unavailable`, "unavailable"),
  ].join(` ${separator} `);
}
