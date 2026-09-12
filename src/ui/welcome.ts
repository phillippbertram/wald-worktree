import path from "node:path";
import pc from "picocolors";
import type { Worktree } from "../domain/types.js";
import { style } from "./style.js";

export type WelcomeSummary = {
  workspaceRoot: string;
  current: Pick<Worktree, "name" | "branch"> | null;
  worktreeCount: number;
};

const wisdoms = [
  "Every tree grows stronger in shared ground.",
  "Many working trees, one shared history.",
  "Give each idea room to grow.",
  "Stable ground makes fearless experiments.",
  "Parallel work grows better in separate worktrees.",
  "A worktree is context without the context switch.",
  "Branch freely. Merge deliberately.",
  "Small commits leave a clear trail through the forest.",
  "Keep the repository steady and the worktrees moving.",
  "Review beside your work, not on top of it.",
  "Automate the setup. Save attention for the work.",
  "Grow experiments freely; prune with care.",
] as const;

export function selectWisdom(random: () => number = Math.random): string {
  const sample = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return wisdoms[Math.floor(sample * wisdoms.length)] as string;
}

export function renderWelcome(
  summary: WelcomeSummary | null,
  random: () => number = Math.random,
): string {
  const lines = [
    pc.green("      🌲  🌳  🌲"),
    `          ${pc.green(pc.bold("Wald"))}`,
    "",
    `  ${pc.dim("Where Git worktrees grow.")}`,
  ];

  if (summary) {
    lines.push("", renderSummary(summary));
  }

  lines.push("", `  ${pc.dim(`“${selectWisdom(random)}”`)}`, "");
  return lines.join("\n");
}

function renderSummary(summary: WelcomeSummary): string {
  const workspaceName = path.basename(summary.workspaceRoot) || summary.workspaceRoot;
  const current = summary.current
    ? `${style.worktree(summary.current.name)} (${style.branch(summary.current.branch ?? "detached")})`
    : "workspace root";
  const worktreeLabel = summary.worktreeCount === 1 ? "worktree" : "worktrees";
  const separator = pc.dim("·");

  return [
    `  ${style.label("Workspace")} ${style.path(workspaceName)}`,
    `${style.label("Current")} ${current}`,
    `${style.value(summary.worktreeCount)} ${worktreeLabel}`,
  ].join(` ${separator} `);
}
