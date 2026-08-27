import path from "node:path";
import pc from "picocolors";
import type { Worktree } from "../domain/types.js";

export type WelcomeSummary = {
  workspaceRoot: string;
  current: Pick<Worktree, "name" | "branch"> | null;
  worktreeCount: number;
};

const wisdoms = [
  "Every branch grows stronger from shared roots.",
  "Many working worlds, one shared history.",
  "Let each idea grow on its own branch.",
  "Deep roots make fearless experiments.",
  "Parallel work deserves parallel worlds.",
  "A worktree is context without the context switch.",
  "Branch freely. Merge deliberately.",
  "Small commits leave a clear trail through the forest.",
  "Keep the roots stable and the branches moving.",
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
    pc.green("       \\ | /"),
    pc.green("        \\|/"),
    `      ${pc.green("🌳")} ${pc.green(pc.bold("Ygg"))}`,
    pc.green("        /|\\"),
    pc.green("       / | \\"),
    "",
    `  ${pc.dim("Git workspaces, rooted together.")}`,
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
    ? `${summary.current.name} (${summary.current.branch ?? "detached"})`
    : "workspace root";
  const worktreeLabel = summary.worktreeCount === 1 ? "worktree" : "worktrees";
  const separator = pc.dim("·");

  return [
    `  ${pc.cyan("Workspace")} ${workspaceName}`,
    `${pc.cyan("Current")} ${current}`,
    `${summary.worktreeCount} ${worktreeLabel}`,
  ].join(` ${separator} `);
}
