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
      schemaVersion: 2,
      mode: "managed",
      gitDir: "../repo.git",
      envDir: "env",
      worktreeDir: "..",
      remote: {
        name: "origin",
        fetchRefspec: "+refs/heads/*:refs/remotes/origin/*",
      },
    });
    expect(await fs.stat(workspace.gitDir)).toSatisfy((stat) => stat.isDirectory());
    expect(await fs.stat(workspace.envDir)).toSatisfy((stat) => stat.isDirectory());

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
