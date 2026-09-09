import { describe, expect, it, vi } from "vitest";
import { YggError } from "../src/domain/errors.js";
import type { GitClient } from "../src/infrastructure/git-client.js";
import type { ConfigService } from "../src/services/config-service.js";
import { DoctorService } from "../src/services/doctor-service.js";
import type { ToolService } from "../src/services/tool-service.js";
import type { WorkspaceService } from "../src/services/workspace-service.js";
import type { WorktreeService } from "../src/services/worktree-service.js";

describe("DoctorService runtime boundaries", () => {
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
      find: vi.fn().mockRejectedValue(new YggError("No ygg workspace found.")),
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
