import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WaldError } from "../src/domain/errors.js";
import type { Workspace } from "../src/domain/types.js";
import type { GitClient } from "../src/infrastructure/git-client.js";
import {
  listWorktreePorcelain,
  parseWorktreePorcelain,
  slugifyBranch,
  validateWorktreeName,
  WorktreeService,
} from "../src/services/worktree-service.js";

describe("worktree domain", () => {
  it("derives safe and stable directory names from branches", () => {
    expect(slugifyBranch("feature/payment flow")).toBe("feature-payment-flow");
    expect(slugifyBranch("release/1.2.0")).toBe("release-1.2.0");
  });

  it.each(["", ".", "..", ".wald", "repo.git", "nested/name", "nested\\name", " line"])(
    "rejects reserved or nested worktree name %s",
    (name) => {
      expect(() => validateWorktreeName(name)).toThrow(WaldError);
    },
  );

  it("parses Git's stable NUL-delimited porcelain format", () => {
    const output = [
      "worktree /tmp/repo.git\0bare\0\0",
      "worktree /tmp/main\0HEAD abc123\0branch refs/heads/main\0\0",
      "worktree /tmp/feature\0HEAD def456\0branch refs/heads/feature/test\0locked maintenance\0\0",
    ].join("");

    expect(parseWorktreePorcelain(output)).toEqual([
      expect.objectContaining({ path: "/tmp/repo.git", bare: true }),
      expect.objectContaining({ path: "/tmp/main", branch: "main", locked: false }),
      expect.objectContaining({
        path: "/tmp/feature",
        branch: "feature/test",
        locked: true,
        lockReason: "maintenance",
      }),
    ]);
  });

  it("parses the line-delimited porcelain format used by Git 2.31", () => {
    const output = [
      'worktree "/tmp/w\\303\\244ld worktree"',
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /tmp/feature",
      "HEAD def456",
      "detached",
      "prunable gitdir file points to a missing location",
    ].join("\n");

    expect(parseWorktreePorcelain(output)).toEqual([
      expect.objectContaining({ path: "/tmp/wäld worktree", branch: "main" }),
      expect.objectContaining({ path: "/tmp/feature", branch: null, prunable: true }),
    ]);
  });

  it("falls back to line-delimited porcelain when Git does not support -z", async () => {
    const git = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "error: unknown switch `z'", exitCode: 129 })
        .mockResolvedValueOnce({
          stdout: "worktree /tmp/main\nHEAD abc123\nbranch refs/heads/main",
          stderr: "",
          exitCode: 0,
        }),
    } as unknown as GitClient;

    await expect(listWorktreePorcelain(git, "/tmp/repo.git")).resolves.toEqual([
      expect.objectContaining({ path: "/tmp/main", branch: "main" }),
    ]);
    expect(git.run).toHaveBeenNthCalledWith(1, ["worktree", "list", "--porcelain", "-z"], {
      gitDir: "/tmp/repo.git",
      reject: false,
    });
    expect(git.run).toHaveBeenNthCalledWith(2, ["worktree", "list", "--porcelain"], {
      gitDir: "/tmp/repo.git",
    });
  });

  it("reports an existing worktree as unavailable when git status fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wald-unavailable-test-"));
    try {
      const git = {
        run: vi.fn().mockImplementation(async (args: string[]) =>
          args[0] === "worktree"
            ? {
                stdout: `worktree ${root}\0HEAD abc123\0branch refs/heads/main\0\0`,
                stderr: "",
                exitCode: 0,
              }
            : { stdout: "", stderr: "broken metadata", exitCode: 128 },
        ),
      } as unknown as GitClient;
      const workspace = {
        gitDir: path.join(root, ".git"),
        worktreeDir: path.dirname(root),
        primaryWorktree: null,
      } as Workspace;

      await expect(new WorktreeService(git).list(workspace)).resolves.toEqual([
        expect.objectContaining({ path: root, state: "unavailable" }),
      ]);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("treats an unavailable state as a non-bypassable removal blocker", async () => {
    const git = { succeeds: vi.fn().mockResolvedValue(false) } as unknown as GitClient;
    const service = new WorktreeService(git);
    vi.spyOn(service, "resolve").mockResolvedValue({
      name: "broken",
      role: "linked",
      path: "/workspace/broken",
      head: "abc123",
      branch: "broken",
      branchRef: "refs/heads/broken",
      locked: false,
      lockReason: null,
      prunable: false,
      state: "unavailable",
    });
    const workspace = {
      config: { defaultBranch: "main", remote: null },
    } as Workspace;

    await expect(service.inspectRemoval(workspace, "broken")).resolves.toMatchObject({
      hardBlockers: ["the worktree state could not be read safely"],
    });
  });
});
