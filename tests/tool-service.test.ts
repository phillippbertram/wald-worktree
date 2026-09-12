import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfigDocument, Worktree } from "../src/domain/types.js";
import type { ProcessRunner } from "../src/infrastructure/process-runner.js";
import { ToolService } from "../src/services/tool-service.js";

describe("tool profiles", () => {
  let root: string;
  let worktree: Worktree;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wald-tool-test-"));
    worktree = {
      name: "feature",
      role: "linked",
      path: root,
      head: "abc",
      branch: "feature",
      branchRef: "refs/heads/feature",
      locked: false,
      lockReason: null,
      prunable: false,
      state: "clean",
    };
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  it("expands {path} before availability checks and launch", async () => {
    const executable = path.join(root, "bin", "editor");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
    const launchDetached = vi.fn();
    const tools = new ToolService({ launchDetached } as unknown as ProcessRunner);
    const project = projectWithTool(["{path}/bin/editor", "{path}/file.txt"]);

    await expect(tools.availableProfiles(project, worktree)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "local-editor" })]),
    );
    await tools.open(worktree, "local-editor", project);
    expect(launchDetached).toHaveBeenCalledWith([executable, path.join(root, "file.txt")], root);
  });

  it("resolves relative executables from the worktree", async () => {
    const executable = path.join(root, "scripts", "editor");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
    const runInteractive = vi.fn();
    const tools = new ToolService({ runInteractive } as unknown as ProcessRunner);
    const project = projectWithTool(["./scripts/editor"], "foreground");

    await tools.open(worktree, "local-editor", project);
    expect(runInteractive).toHaveBeenCalledWith(["./scripts/editor"], root);
  });
});

function projectWithTool(
  command: string[],
  mode: "foreground" | "detached" = "detached",
): ProjectConfigDocument {
  return {
    path: ".wald.yml",
    sources: { repository: ".wald.yml", workspace: null },
    hash: "hash",
    requiresTrust: false,
    config: {
      version: 1,
      defaults: { fetch: true },
      hooks: { pre_create: [], post_create: [], pre_remove: [], post_remove: [] },
      tasks: {},
      tools: {
        "local-editor": { command, mode },
      },
    },
  };
}
