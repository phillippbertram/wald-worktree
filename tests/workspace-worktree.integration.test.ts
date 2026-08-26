import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/infrastructure/git-client.js";
import { WorkspaceService } from "../src/services/workspace-service.js";
import { WorktreeService } from "../src/services/worktree-service.js";
import {
  createRemoteBranch,
  createTestRepository,
  type TestRepository,
} from "./helpers/git-repository.js";

describe("managed Git workspace", () => {
  let temporaryRoot: string;
  let repository: TestRepository;
  let workspaces: WorkspaceService;
  let worktrees: WorktreeService;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wt-workspace-test-"));
    repository = await createTestRepository(temporaryRoot);
    const git = new GitClient();
    workspaces = new WorkspaceService(git);
    worktrees = new WorktreeService(git);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("initializes a bare workspace with default and remote-tracking refs", async () => {
    const target = path.join(temporaryRoot, "workspace");
    const workspace = await workspaces.initialize(repository.remote, target);

    expect(workspace.config.defaultBranch).toBe("main");
    expect(workspace.config).toMatchObject({
      version: 1,
      mode: "managed",
      paths: {
        git: "../repo.git",
        worktrees: "..",
        primaryWorktree: null,
      },
      remote: {
        name: "origin",
        fetchRefspec: "+refs/heads/*:refs/remotes/origin/*",
      },
      trustedProjectConfig: null,
    });
    expect(workspace.configPath).toBe(await fs.realpath(path.join(target, ".wt", "workspace.yml")));
    expect(await fs.stat(workspace.gitDir)).toSatisfy((stat) => stat.isDirectory());

    const remoteMain = await new GitClient().succeeds(
      ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"],
      { gitDir: workspace.gitDir },
    );
    expect(remoteMain).toBe(true);
    expect(await worktrees.list(workspace)).toEqual([]);

    const repeated = await workspaces.inspectAdoption(workspace.root);
    expect(repeated.existingWorkspace).toMatchObject({ configPath: workspace.configPath });
  });

  it("finds the workspace from inside a linked worktree", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "workspace"),
    );
    const main = await worktrees.add(workspace, { branch: "main", fetch: false });
    const nested = path.join(main.path, "packages", "api");
    await fs.mkdir(nested, { recursive: true });

    await expect(workspaces.find(nested)).resolves.toMatchObject({ root: workspace.root });
  });

  it("supports a grouped worktree directory inside the workspace root", async () => {
    const target = path.join(temporaryRoot, "grouped-workspace");
    const workspace = await workspaces.initialize(repository.remote, target, temporaryRoot, {
      worktreeDir: "trees",
    });

    expect(workspace.root).toBe(await fs.realpath(target));
    expect(workspace.worktreeDir).toBe(await fs.realpath(path.join(target, "trees")));
    expect(workspace.sharedDir).toBe(await fs.realpath(path.join(target, ".wt", "shared")));
    expect(workspace.config.paths.worktrees).toBe("../trees");
    expect((await fs.stat(workspace.sharedDir)).mode & 0o777).toBe(0o700);

    const main = await worktrees.add(workspace, { branch: "main", fetch: false });
    expect(main.path).toBe(path.join(workspace.worktreeDir, "main"));
    await expect(workspaces.find(main.path)).resolves.toMatchObject({
      root: workspace.root,
      worktreeDir: workspace.worktreeDir,
    });
    await expect(worktrees.resolve(workspace, "main")).resolves.toMatchObject({ path: main.path });
  });

  it("creates a standalone local-only workspace without changing the source checkout", async () => {
    const git = new GitClient();
    await git.run(["switch", "-c", "feature/local"], { cwd: repository.source });
    await fs.writeFile(path.join(repository.source, "local.txt"), "local branch\n", "utf8");
    await git.run(["add", "local.txt"], { cwd: repository.source });
    await git.run(["commit", "-m", "local branch"], { cwd: repository.source });
    await git.run(["switch", "main"], { cwd: repository.source });
    await fs.writeFile(path.join(repository.source, "README.md"), "# stashed\n", "utf8");
    await git.run(["stash", "push", "-m", "keep in source"], { cwd: repository.source });
    await fs.writeFile(path.join(repository.source, "uncommitted.txt"), "keep here\n", "utf8");
    await git.run(["remote", "remove", "origin"], { cwd: repository.source });

    const statusBefore = await git.run(["status", "--porcelain=v1"], { cwd: repository.source });
    const inspection = await workspaces.inspectAdoption(repository.source, {
      remote: null,
      defaultBranch: "main",
    });
    expect(inspection).toMatchObject({ modified: true, stashCount: 1, remoteName: null });

    const workspace = await workspaces.initializeFromExisting(
      inspection,
      path.join(temporaryRoot, "local-workspace"),
      temporaryRoot,
      { worktreeDir: "worktrees" },
    );
    expect(workspace.config.remote).toBeNull();
    expect(
      await git.succeeds(["show-ref", "--verify", "--quiet", "refs/heads/feature/local"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(true);
    expect((await git.run(["remote"], { gitDir: workspace.gitDir })).stdout).toBe("");
    expect((await git.run(["status", "--porcelain=v1"], { cwd: repository.source })).stdout).toBe(
      statusBefore.stdout,
    );
    expect((await git.run(["stash", "list"], { cwd: repository.source })).stdout).toContain(
      "keep in source",
    );

    const main = await worktrees.add(workspace, { branch: "main", fetch: false });
    expect(main.path).toBe(path.join(workspace.root, "worktrees", "main"));
  });

  it("preserves the selected remote connection in a standalone local copy", async () => {
    const git = new GitClient();
    const sourceConfig = await fs.readFile(path.join(repository.source, ".git", "config"), "utf8");
    const inspection = await workspaces.inspectAdoption(repository.source, {
      remote: "origin",
      defaultBranch: "main",
    });
    const workspace = await workspaces.initializeFromExisting(
      inspection,
      path.join(temporaryRoot, "copied-workspace"),
      temporaryRoot,
    );

    expect(workspace.config.remote).toMatchObject({ name: "origin" });
    expect(
      (await git.run(["remote", "get-url", "origin"], { gitDir: workspace.gitDir })).stdout,
    ).toBe(repository.remote);
    expect(await fs.readFile(path.join(repository.source, ".git", "config"), "utf8")).toBe(
      sourceConfig,
    );
  });

  it("rejects a standalone worktree directory outside the workspace root", async () => {
    const target = path.join(temporaryRoot, "bounded-workspace");
    await expect(
      workspaces.initialize(repository.remote, target, temporaryRoot, {
        worktreeDir: "../outside",
      }),
    ).rejects.toThrow(/must stay inside the workspace root/u);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves local, remote-only, and new branches deterministically", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "workspace"),
    );
    const main = await worktrees.add(workspace, { branch: "main", fetch: false });
    expect(main.branch).toBe("main");

    await createRemoteBranch(repository, "remote-only");
    const remote = await worktrees.add(workspace, { branch: "remote-only" });
    expect(remote.branch).toBe("remote-only");
    const upstream = await new GitClient().run(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd: remote.path },
    );
    expect(upstream.stdout).toBe("origin/remote-only");

    const feature = await worktrees.add(workspace, {
      branch: "feature/payment",
      from: "origin/main",
      fetch: false,
    });
    expect(feature.name).toBe("feature-payment");
    expect(feature.branch).toBe("feature/payment");

    await expect(
      worktrees.add(workspace, { branch: "feature/payment", fetch: false }),
    ).rejects.toThrow(/already checked out/u);
  });

  it("suggests --name when branch slugs collide", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "slug-workspace"),
    );
    await worktrees.add(workspace, { branch: "feature/a-b", fetch: false });

    await expect(worktrees.add(workspace, { branch: "feature-a/b", fetch: false })).rejects.toThrow(
      /Choose another directory with --name <directory>/u,
    );
  });

  it("reports modifications and blocks unsafe removal", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "workspace"),
    );
    const feature = await worktrees.add(workspace, {
      branch: "feature/unmerged",
      fetch: false,
    });
    const git = new GitClient();
    await git.run(["config", "user.email", "tests@example.invalid"], { cwd: feature.path });
    await git.run(["config", "user.name", "wt tests"], { cwd: feature.path });
    await fs.writeFile(path.join(feature.path, "README.md"), "# changed\n", "utf8");
    await git.run(["add", "README.md"], { cwd: feature.path });
    await git.run(["commit", "-m", "feature change"], { cwd: feature.path });
    await fs.writeFile(path.join(feature.path, "untracked.txt"), "change\n", "utf8");

    const inspection = await worktrees.inspectRemoval(workspace, feature.name);
    expect(inspection.dirty).toBe(true);
    expect(inspection.merged).toBe(false);
    expect(inspection.blockers).toHaveLength(2);
  });
});
