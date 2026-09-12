import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { DoctorReport } from "../src/services/doctor-service.js";
import { renderDoctorReport } from "../src/ui/doctor.js";

describe("doctor presentation", () => {
  it("groups checks into a compact Flutter-style summary", () => {
    const output = plain(renderDoctorReport(outsideWorkspaceReport));

    expect(output).toBe(
      [
        "Doctor summary (run ygg doctor --verbose for details):",
        "[✓] Runtime — Node.js 24.19.0 · Git 2.50.1",
        "[!] Workspace — No Ygg workspace was found from the current directory.",
        "    → Run ygg init in a Git repository or provide a repository to clone.",
        "",
        "1 warning found.",
      ].join("\n"),
    );
    expect(output).not.toContain("workspace.discovery");
    expect(output).not.toContain("Workspace-specific checks require");
  });

  it("shows individual check identifiers and skipped checks in verbose mode", () => {
    const output = plain(renderDoctorReport(outsideWorkspaceReport, { verbose: true }));

    expect(output).toContain("Doctor details");
    expect(output).toContain("Node.js (runtime.node)");
    expect(output).toContain("Workspace discovery (workspace.discovery)");
    expect(output).toContain("Workspace details (workspace.details)");
    expect(output).toContain("→ Run ygg init in a Git repository");
  });

  it("summarizes multiple issues without hiding their suggestions", () => {
    const output = plain(
      renderDoctorReport({
        status: "fail",
        checks: [
          {
            id: "project.trust",
            status: "warning",
            summary: "Executable project configuration is not trusted.",
            suggestion: "Review the configuration before trusting it.",
          },
          {
            id: "project.file-sources",
            status: "fail",
            summary: "One required file source is unavailable.",
            suggestion: "Restore the source file.",
          },
        ],
      }),
    );

    expect(output).toContain("[✗] Project configuration");
    expect(output).toContain("[!] Executable project configuration is not trusted.");
    expect(output).toContain("[✗] One required file source is unavailable.");
    expect(output).toContain("1 failure and 1 warning found.");
  });
});

const outsideWorkspaceReport: DoctorReport = {
  status: "warning",
  checks: [
    {
      id: "runtime.node",
      status: "pass",
      summary: "Node.js 24.19.0 satisfies the minimum version 22.13.0.",
    },
    {
      id: "runtime.git",
      status: "pass",
      summary: "Git 2.50.1 satisfies the minimum version 2.31.0.",
    },
    {
      id: "workspace.discovery",
      status: "warning",
      summary: "No Ygg workspace was found from the current directory.",
      suggestion: "Run ygg init in a Git repository or provide a repository to clone.",
    },
    {
      id: "workspace.details",
      status: "skipped",
      summary: "Workspace-specific checks require a valid workspace configuration.",
    },
  ],
};

function plain(value: string): string {
  return stripVTControlCharacters(value);
}
