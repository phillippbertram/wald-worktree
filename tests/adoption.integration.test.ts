import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/infrastructure/git-client.js";
import { EnvironmentService } from "../src/services/environment-service.js";
import { WorkspaceService } from "../src/services/workspace-service.js";
import { WorktreeService } from "../src/services/worktree-service.js";
import {
  createRemoteBranch,
  createTestRepository,
  type TestRepository,
} from "./helpers/git-repository.js";

describe("adopting existing Git repositories", () => {
  let temporaryRoot: string;
  let repository: TestRepository;
  let git: GitClient;
  let workspaces: WorkspaceService;
  let worktrees: WorktreeService;

  beforeEach(async () => {
    temporaryRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "wt-adoption-test-")),
    );
    repository = await createTestRepository(temporaryRoot);
    git = new GitClient();
    workspaces = new WorkspaceService(git);
    worktrees = new WorktreeService(git);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("adopts a dirty local-only checkout without changing its Git configuration or status", async () => {
    await git.run(["remote", "remove", "origin"], { cwd: repository.source });
    await fs.writeFile(path.join(repository.source, "untracked.txt"), "keep me\n", "utf8");
    const gitConfigPath = path.join(repository.source, ".git", "config");
    const configBefore = await fs.readFile(gitConfigPath, "utf8");
    const statusBefore = await git.run(["status", "--porcelain=v1"], { cwd: repository.source });

    const inspection = await workspaces.inspectAdoption(repository.source, { remote: null });
    expect(inspection).toMatchObject({
      bare: false,
      defaultBranch: "main",
      primaryWorktree: repository.source,
      remoteName: null,
      remoteSelectionRequired: false,
      worktreeDir: path.join(temporaryRoot, "source-worktrees"),
    });

    const workspace = await workspaces.adopt(inspection);
    expect(workspace.config).toMatchObject({
      schemaVersion: 2,
      mode: "adopted",
      remote: null,
      defaultBranch: "main",
    });
    expect(workspace.primaryWorktree).toBe(repository.source);
    expect(await fs.readFile(gitConfigPath, "utf8")).toBe(configBefore);
    expect((await git.run(["status", "--porcelain=v1"], { cwd: repository.source })).stdout).toBe(
      statusBefore.stdout,
    );
    expect((await fs.lstat(path.join(workspace.worktreeDir, ".wt"))).isSymbolicLink()).toBe(true);
    expect((await fs.stat(path.join(repository.source, ".git", "wt"))).mode & 0o777).toBe(0o700);

    await expect(workspaces.find(repository.source)).resolves.toMatchObject({
      worktreeDir: workspace.worktreeDir,
    });
    await expect(workspaces.find(workspace.worktreeDir)).resolves.toMatchObject({
      gitDir: workspace.gitDir,
    });

    const feature = await worktrees.add(workspace, { branch: "feature/local" });
    expect(feature.path).toBe(path.join(workspace.worktreeDir, "feature-local"));
    expect(feature.role).toBe("linked");
    const listed = await worktrees.list(workspace);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: repository.source, role: "primary" }),
        expect.objectContaining({ path: feature.path, role: "linked" }),
      ]),
    );

    const removal = await worktrees.inspectRemoval(workspace, repository.source);
    expect(removal.hardBlockers).toEqual(["the primary checkout cannot be removed by wt"]);
    await expect(worktrees.remove(workspace, removal.worktree, true)).rejects.toThrow(
      /primary checkout/u,
    );
  });

  it("uses its own fetch refspec without changing the adopted remote configuration", async () => {
    const gitConfigPath = path.join(repository.source, ".git", "config");
    const configBefore = await fs.readFile(gitConfigPath, "utf8");
    const workspace = await workspaces.adopt(
      await workspaces.inspectAdoption(repository.source, { defaultBranch: "main" }),
    );
    expect(await fs.readFile(gitConfigPath, "utf8")).toBe(configBefore);

    await createRemoteBranch(repository, "remote-only");
    const remote = await worktrees.add(workspace, { branch: "remote-only" });
    expect(remote.path).toBe(path.join(workspace.worktreeDir, "remote-only"));
    expect(
      (
        await git.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
          cwd: remote.path,
        })
      ).stdout,
    ).toBe("origin/remote-only");
  });

  it("adopts a bare repository with existing sibling worktrees", async () => {
    const layout = path.join(temporaryRoot, "bare-workspace");
    const bareRepository = path.join(layout, "repo.git");
    const mainWorktree = path.join(layout, "main");
    await fs.mkdir(layout);
    await git.run(["clone", "--bare", "--", repository.remote, bareRepository], {
      cwd: temporaryRoot,
    });
    await git.run(["worktree", "add", mainWorktree, "main"], { gitDir: bareRepository });
    const configBefore = await fs.readFile(path.join(bareRepository, "config"), "utf8");

    const inspection = await workspaces.inspectAdoption(bareRepository);
    expect(inspection).toMatchObject({
      bare: true,
      defaultBranch: "main",
      primaryWorktree: null,
      worktreeDir: layout,
    });
    const workspace = await workspaces.adopt(inspection);

    expect(await fs.readFile(path.join(bareRepository, "config"), "utf8")).toBe(configBefore);
    expect((await worktrees.list(workspace))[0]).toMatchObject({
      path: mainWorktree,
      role: "linked",
    });
    await expect(workspaces.find(mainWorktree)).resolves.toMatchObject({ root: layout });
    await expect(workspaces.find(layout)).resolves.toMatchObject({ gitDir: bareRepository });
  });

  it("requires a remote choice when an existing repository has multiple remotes", async () => {
    await git.run(["remote", "add", "upstream", repository.remote], { cwd: repository.source });

    const ambiguous = await workspaces.inspectAdoption(repository.source);
    expect(ambiguous.remoteSelectionRequired).toBe(true);
    expect(ambiguous.defaultBranch).toBeNull();
    expect(ambiguous.remotes).toEqual(["origin", "upstream"]);

    const resolved = await workspaces.inspectAdoption(repository.source, { remote: "origin" });
    expect(resolved.remoteSelectionRequired).toBe(false);
    expect(resolved.remoteName).toBe("origin");
    expect(resolved.defaultBranch).toBe("main");
  });

  it("requests an explicit worktree directory when the safe default collides", async () => {
    const defaultDirectory = path.join(temporaryRoot, "source-worktrees");
    await fs.writeFile(defaultDirectory, "occupied\n", "utf8");

    const inspection = await workspaces.inspectAdoption(repository.source);
    expect(inspection.worktreeDir).toBe(defaultDirectory);
    expect(inspection.worktreeDirSelectionRequired).toBe(true);
    await expect(
      workspaces.inspectAdoption(repository.source, { worktreeDir: defaultDirectory }),
    ).rejects.toThrow(/not a directory/u);
  });

  it("reuses a dedicated container discovered from existing linked worktrees", async () => {
    const worktreeDir = path.join(temporaryRoot, "source-worktrees");
    const existingWorktree = path.join(worktreeDir, "existing-feature");
    await fs.mkdir(worktreeDir);
    await git.run(["worktree", "add", "-b", "feature/existing", existingWorktree, "main"], {
      cwd: repository.source,
    });

    const inspection = await workspaces.inspectAdoption(repository.source, {
      defaultBranch: "main",
    });
    expect(inspection.worktreeDir).toBe(worktreeDir);

    const workspace = await workspaces.adopt(inspection);
    expect(
      await workspaces.adopt(await workspaces.inspectAdoption(existingWorktree)),
    ).toMatchObject({ configPath: workspace.configPath });
    await expect(
      workspaces.inspectAdoption(existingWorktree, {
        worktreeDir: path.join(temporaryRoot, "different-worktrees"),
      }),
    ).rejects.toThrow(/different worktree directory/u);
  });

  it("keeps schema-one workspaces readable without rewriting their config", async () => {
    const root = path.join(temporaryRoot, "legacy-workspace");
    const metadataDir = path.join(root, ".wt");
    await fs.mkdir(path.join(metadataDir, "env"), { recursive: true });
    await git.run(["clone", "--bare", "--", repository.remote, path.join(root, "repo.git")], {
      cwd: temporaryRoot,
    });
    const legacyConfig = {
      schemaVersion: 1,
      gitDir: "repo.git",
      envDir: ".wt/env",
      remote: "origin",
      defaultBranch: "main",
    } as const;
    const configPath = path.join(metadataDir, "config.json");
    await fs.writeFile(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

    const workspace = await workspaces.find(root);
    expect(workspace.config).toMatchObject({ schemaVersion: 2, mode: "managed" });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(legacyConfig);
  });

  it("rejects absolute paths in an adopted workspace config", async () => {
    const workspace = await workspaces.adopt(
      await workspaces.inspectAdoption(repository.source, { defaultBranch: "main" }),
    );
    const config = JSON.parse(await fs.readFile(workspace.configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.worktreeDir = workspace.worktreeDir;
    await fs.writeFile(workspace.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    await expect(workspaces.find(repository.source)).rejects.toThrow(
      /worktreeDir must be relative/u,
    );
  });

  it("shares adopted environment files through relative links", async () => {
    const workspace = await workspaces.adopt(
      await workspaces.inspectAdoption(repository.source, { defaultBranch: "main" }),
    );
    const environments = new EnvironmentService(git);
    await fs.writeFile(path.join(repository.source, ".env"), "TEST_VALUE=fixture\n", "utf8");
    const primary = (await worktrees.list(workspace)).find(
      (worktree) => worktree.role === "primary",
    );
    if (!primary) {
      throw new Error("Expected the adopted primary worktree to be listed.");
    }

    const candidates = await environments.discoverImportCandidates(workspace, primary);
    await environments.importFiles(workspace, primary, candidates);
    const feature = await worktrees.add(workspace, { branch: "feature/environment" });
    await environments.sync(workspace, feature);

    const link = await fs.readlink(path.join(feature.path, ".env"));
    expect(path.isAbsolute(link)).toBe(false);
    expect(await fs.readFile(path.join(workspace.envDir, ".env"), "utf8")).toBe(
      "TEST_VALUE=fixture\n",
    );
  });
});
