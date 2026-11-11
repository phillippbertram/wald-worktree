import { describe, expect, it, vi } from "vitest";
import { WaldError } from "../src/domain/errors.js";
import type { GitClient } from "../src/infrastructure/git-client.js";
import type { ConfigService } from "../src/services/config-service.js";
import { DoctorService } from "../src/services/doctor-service.js";
import type { ToolService } from "../src/services/tool-service.js";
import type { WorkspaceService } from "../src/services/workspace-service.js";
import type { WorktreeService } from "../src/services/worktree-service.js";

describe("DoctorService runtime boundaries", () => {
  it("reports Bun instead of its emulated Node version", async () => {
    const service = new DoctorService(
      { run: vi.fn().mockResolvedValue({ stdout: "git version 2.31.0" }) } as unknown as GitClient,
      {
        find: vi.fn().mockRejectedValue(new WaldError("No wald workspace found.")),
      } as unknown as WorkspaceService,
      {} as WorktreeService,
      {} as ConfigService,
      {} as ToolService,
      { nodeVersion: "22.0.0", bunVersion: "1.4.4" },
    );

    const report = await service.inspect("/outside");

    expect(report.checks).toContainEqual({
      id: "runtime.bun",
      status: "pass",
      summary: "Bun 1.4.4 provides the JavaScript runtime.",
    });
    expect(report.checks.some((check) => check.id === "runtime.node")).toBe(false);
  });

  it.each([
    { node: "22.13.0", git: "2.31.0", nodeStatus: "pass", gitStatus: "pass" },
    { node: "22.12.9", git: "2.31.0", nodeStatus: "fail", gitStatus: "pass" },
    { node: "22.13.0", git: "2.30.9", nodeStatus: "pass", gitStatus: "fail" },
  ])("checks Node $node and Git $git against exact minimums", async (sample) => {
    const git = {
      run: vi.fn().mockResolvedValue({
        stdout: `git version ${sample.git}`,
        stderr: "",
        exitCode: 0,
      }),
    } as unknown as GitClient;
    const workspaces = {
      find: vi.fn().mockRejectedValue(new WaldError("No wald workspace found.")),
    } as unknown as WorkspaceService;
    const service = new DoctorService(
      git,
      workspaces,
      {} as WorktreeService,
      {} as ConfigService,
      {} as ToolService,
      { nodeVersion: sample.node },
    );

    const report = await service.inspect("/outside");

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "runtime.node", status: sample.nodeStatus }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "runtime.git", status: sample.gitStatus }),
    );
  });
});
