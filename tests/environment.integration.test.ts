import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/infrastructure/git-client.js";
import { EnvironmentService } from "../src/services/environment-service.js";
import { WorkspaceService } from "../src/services/workspace-service.js";
import { WorktreeService } from "../src/services/worktree-service.js";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

describe("shared environment files", () => {
  let temporaryRoot: string;
  let repository: TestRepository;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wt-env-test-"));
    repository = await createTestRepository(temporaryRoot);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("imports ignored files, preserves conflicts, and synchronizes relative links", async () => {
    const git = new GitClient();
    const workspaces = new WorkspaceService(git);
    const worktrees = new WorktreeService(git);
    const environments = new EnvironmentService(git);
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "workspace"),
    );
    const main = await worktrees.add(workspace, { branch: "main", fetch: false });

    await fs.mkdir(path.join(main.path, "apps", "api"), { recursive: true });
    await fs.mkdir(path.join(main.path, "apps", "web"), { recursive: true });
    await fs.mkdir(path.join(main.path, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(main.path, "fixtures"), { recursive: true });
    await fs.writeFile(path.join(main.path, "apps", "api", ".env"), "API_PORT=4000\n");
    await fs.writeFile(path.join(main.path, "apps", "web", ".env.local"), "WEB_PORT=3000\n");
    await fs.writeFile(path.join(main.path, "node_modules", "pkg", ".env"), "VENDOR=1\n");
    await fs.writeFile(path.join(main.path, "fixtures", ".env"), "FIXTURE=1\n");
    await fs.writeFile(path.join(main.path, ".env.example"), "EXAMPLE=1\n");

    const candidates = await environments.discoverImportCandidates(workspace, main);
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "apps/api/.env",
      "apps/web/.env.local",
    ]);

    const imported = await environments.importFiles(workspace, main, candidates);
    expect(imported.imported).toHaveLength(2);
    expect(imported.linked).toHaveLength(2);
    expect((await fs.lstat(path.join(main.path, "apps", "api", ".env"))).isSymbolicLink()).toBe(
      true,
    );
    expect(await fs.readFile(path.join(workspace.envDir, "apps", "api", ".env"), "utf8")).toBe(
      "API_PORT=4000\n",
    );

    const feature = await worktrees.add(workspace, {
      branch: "feature/env",
      fetch: false,
      name: "feature-env",
    });
    const synchronized = await environments.sync(workspace, feature);
    expect(synchronized.created).toHaveLength(2);
    const link = await fs.readlink(path.join(feature.path, "apps", "api", ".env"));
    expect(path.isAbsolute(link)).toBe(false);

    const webEnv = path.join(feature.path, "apps", "web", ".env.local");
    await fs.unlink(webEnv);
    await fs.writeFile(webEnv, "LOCAL_OVERRIDE=1\n");
    const conflict = await environments.sync(workspace, feature, { repair: true });
    expect(conflict.conflicts.map((status) => status.path)).toEqual(["apps/web/.env.local"]);
    expect(await fs.readFile(webEnv, "utf8")).toBe("LOCAL_OVERRIDE=1\n");

    const apiEnv = path.join(feature.path, "apps", "api", ".env");
    await fs.unlink(apiEnv);
    await fs.symlink("../wrong", apiEnv);
    const repaired = await environments.sync(workspace, feature, { repair: true });
    expect(repaired.repaired).toEqual(["apps/api/.env"]);
  });
});
