import pc from "picocolors";
import type { DoctorCheck, DoctorCheckStatus, DoctorReport } from "../services/doctor-service.js";
import { style } from "./style.js";

type DoctorSectionId = "runtime" | "workspace" | "repository" | "worktrees" | "project";

type DoctorSection = {
  id: DoctorSectionId;
  label: string;
  checks: DoctorCheck[];
  status: DoctorCheckStatus;
};

const sectionLabels: Record<DoctorSectionId, string> = {
  runtime: "Runtime",
  workspace: "Workspace",
  repository: "Git repository",
  worktrees: "Worktrees",
  project: "Project configuration",
};

const checkLabels: Record<string, string> = {
  "runtime.node": "Node.js",
  "runtime.git": "Git",
  "workspace.discovery": "Workspace discovery",
  "workspace.configuration": "Workspace configuration",
  "workspace.details": "Workspace details",
  "workspace.marker": "Workspace marker",
  "paths.git": "Git directory",
  "paths.metadata": "Metadata directory",
  "paths.worktrees": "Worktree directory",
  "paths.shared": "Shared directory",
  "paths.primary": "Primary checkout",
  "git.common-directory": "Git common directory",
  "git.invocation-context": "Current checkout",
  "git.remote": "Remote",
  "git.default-branch": "Default branch",
  "git.worktrees": "Worktree registrations",
  "git.worktree-locks": "Worktree locks",
  "project.configuration": "Configuration",
  "project.trust": "Trust",
  "project.executables": "Executables",
  "project.file-sources": "File sources",
};

export function renderDoctorReport(
  report: DoctorReport,
  options: { verbose?: boolean } = {},
): string {
  const lines = options.verbose ? renderDetails(report) : renderSummary(report);
  lines.push("", renderOutcome(report));
  return lines.join("\n");
}

function renderSummary(report: DoctorReport): string[] {
  const lines = [
    `${style.heading("Doctor summary")} ${pc.dim("(run ygg doctor --verbose for details):")}`,
  ];
  for (const section of sections(report.checks)) {
    const issues = section.checks.filter(
      (check) => check.status === "fail" || check.status === "warning",
    );
    if (issues.length <= 1) {
      const summary = issues[0]?.summary ?? healthySectionSummary(section);
      lines.push(`${statusMarker(section.status)} ${style.heading(section.label)} — ${summary}`);
      if (issues[0]?.suggestion) lines.push(`    ${pc.dim("→")} ${issues[0].suggestion}`);
      continue;
    }

    lines.push(`${statusMarker(section.status)} ${style.heading(section.label)}`);
    for (const check of issues) {
      lines.push(`    ${statusMarker(check.status)} ${check.summary}`);
      if (check.suggestion) lines.push(`        ${pc.dim("→")} ${check.suggestion}`);
    }
  }
  return lines;
}

function renderDetails(report: DoctorReport): string[] {
  const lines = [style.heading("Doctor details")];
  for (const check of report.checks) {
    const label = checkLabels[check.id] ?? check.id;
    lines.push(
      `${statusMarker(check.status)} ${style.heading(label)} ${pc.dim(`(${check.id})`)} — ${check.summary}`,
    );
    if (check.suggestion) lines.push(`    ${pc.dim("→")} ${check.suggestion}`);
  }
  return lines;
}

function sections(checks: DoctorCheck[]): DoctorSection[] {
  const grouped = new Map<DoctorSectionId, DoctorCheck[]>();
  for (const check of checks) {
    const id = sectionId(check.id);
    const existing = grouped.get(id) ?? [];
    existing.push(check);
    grouped.set(id, existing);
  }
  return (["runtime", "workspace", "repository", "worktrees", "project"] as const).flatMap((id) => {
    const sectionChecks = grouped.get(id) ?? [];
    return sectionChecks.length > 0
      ? [
          {
            id,
            label: sectionLabels[id],
            checks: sectionChecks,
            status: sectionStatus(sectionChecks),
          },
        ]
      : [];
  });
}

function sectionId(checkId: string): DoctorSectionId {
  if (checkId.startsWith("runtime.")) return "runtime";
  if (checkId.startsWith("workspace.") || checkId.startsWith("paths.")) return "workspace";
  if (checkId === "git.worktrees" || checkId === "git.worktree-locks") return "worktrees";
  if (checkId.startsWith("git.")) return "repository";
  return "project";
}

function sectionStatus(checks: DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warning")) return "warning";
  if (checks.every((check) => check.status === "skipped")) return "skipped";
  return "pass";
}

function healthySectionSummary(section: DoctorSection): string {
  switch (section.id) {
    case "runtime":
      return section.checks
        .flatMap((check) => check.summary.match(/^(?:Node\.js|Git)\s+[^\s]+/u)?.[0] ?? [])
        .join(` ${pc.dim("·")} `);
    case "workspace":
      return "Configuration and paths are valid.";
    case "repository":
      return "Repository identity and configured refs are consistent.";
    case "worktrees": {
      const registrations = section.checks.find((check) => check.id === "git.worktrees");
      const locks = section.checks.find((check) => check.id === "git.worktree-locks");
      const lockSummary = locks?.summary.startsWith("No worktrees")
        ? ""
        : ` ${locks?.summary ?? ""}`;
      return `${registrations?.summary ?? "Worktree registrations are consistent."}${lockSummary}`;
    }
    case "project": {
      const configuration = section.checks.find((check) => check.id === "project.configuration");
      return configuration?.status === "skipped"
        ? "No project configuration is active."
        : "Configuration, trust, tools, and file sources are valid.";
    }
  }
}

function statusMarker(status: DoctorCheckStatus): string {
  switch (status) {
    case "pass":
      return style.success("[✓]");
    case "warning":
      return style.warning("[!]");
    case "fail":
      return style.danger("[✗]");
    case "skipped":
      return pc.dim("[–]");
  }
}

function renderOutcome(report: DoctorReport): string {
  const failures = report.checks.filter((check) => check.status === "fail").length;
  const warnings = report.checks.filter((check) => check.status === "warning").length;
  if (failures > 0) {
    const failureText = `${failures} ${failures === 1 ? "failure" : "failures"}`;
    const warningText =
      warnings > 0 ? ` and ${warnings} ${warnings === 1 ? "warning" : "warnings"}` : "";
    return style.danger(`${failureText}${warningText} found.`);
  }
  if (warnings > 0) {
    return style.warning(`${warnings} ${warnings === 1 ? "warning" : "warnings"} found.`);
  }
  return style.success("No issues found.");
}
