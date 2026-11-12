import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, Worktree } from "../src/domain/types.js";
import { GitClient } from "../src/infrastructure/git-client.js";
import { WorkspaceService } from "../src/services/workspace-service.js";
import { WorktreeService } from "../src/services/worktree-service.js";
import {
  createRemoteBranch,
  createTestRepository,
  type TestRepository,
} from "./helpers/git-repository.js";

describe("worktree and branch rename", { timeout: 20_000 }, () => {
  let root: string;
  let repository: TestRepository;
  let workspace: Workspace;
  let feature: Worktree;
  let git: GitClient;
  let service: WorktreeService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wald-rename-test-"));
    repository = await createTestRepository(root);
    await createRemoteBranch(repository, "feature/payment");
    git = new GitClient();
    service = new WorktreeService(git);
    workspace = await new WorkspaceService(git).initialize(
      repository.remote,
      path.join(root, "workspace"),
    );
    feature = await service.add(workspace, { branch: "feature/payment", fetch: false });
    await localGit("branch", "--set-upstream-to=origin/feature/payment", "feature/payment");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function localGit(...args: string[]) {
    return (await git.run(args, { gitDir: workspace.gitDir })).stdout;
  }

  async function snapshot(worktreePath: string) {
    const read = async (...args: string[]) => (await git.run(args, { cwd: worktreePath })).stdout;
    return {
      head: await read("rev-parse", "HEAD"),
      index: await read("ls-files", "--stage", "-z"),
      staged: await read("diff", "--cached", "--binary"),
      unstaged: await read("diff", "--binary"),
      status: await read("status", "--porcelain=v1", "-z", "--untracked-files=all"),
      readme: await fs.readFile(path.join(worktreePath, "README.md")),
      mode: (await fs.stat(path.join(worktreePath, "README.md"))).mode,
    };
  }

  async function expectOriginal() {
    expect(await service.resolve(workspace, feature.path)).toMatchObject({
      path: feature.path,
      branch: feature.branch,
      head: feature.head,
    });
    expect(await localGit("rev-parse", `${feature.branch}@{upstream}`)).toBe(feature.head);
    expect(
      await git.succeeds(["show-ref", "--verify", "--quiet", "refs/heads/payment-review"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(false);
    await expect(fs.lstat(path.join(workspace.root, "payment-review"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }

  it.each([false, true])(
    "preserves HEAD, index, files, modes, tracking and remote refs (dirty=%s)",
    async (dirty) => {
      if (dirty) {
        await fs.writeFile(path.join(feature.path, "README.md"), "# staged\n");
        await git.run(["add", "README.md"], { cwd: feature.path });
        await fs.appendFile(path.join(feature.path, "README.md"), "unstaged\n");
        await fs.chmod(path.join(feature.path, "README.md"), 0o755);
        await fs.writeFile(path.join(feature.path, "local.bin"), Buffer.from([0, 255, 10]));
        await fs.writeFile(path.join(feature.path, ".env"), "EXAMPLE_VALUE=preserved\n");
        await fs.symlink("README.md", path.join(feature.path, "readme-link"));
      }
      await localGit("config", "branch.feature/payment.rebase", "true");
      await localGit("config", "branch.feature/payment.description", "Keep this description");
      const before = await snapshot(feature.path);
      const remotes = await localGit("for-each-ref", "refs/remotes/");
      const remoteRefs = (await git.run(["show-ref"], { gitDir: repository.remote })).stdout;
      const plan = await service.prepareMove(
        workspace,
        feature.name,
        "payment-review",
        workspace.root,
      );
      expect(plan.branchChange).toEqual({
        before: "feature/payment",
        after: "payment-review",
        renamed: true,
        upstream: "origin/feature/payment",
      });

      const moved = await service.move(workspace, plan);

      expect(moved).toMatchObject({
        branch: "payment-review",
        branchRef: "refs/heads/payment-review",
        state: dirty ? "modified" : "clean",
      });
      expect(await snapshot(moved.path)).toEqual(before);
      expect(await localGit("config", "branch.payment-review.remote")).toBe("origin");
      expect(await localGit("config", "branch.payment-review.merge")).toBe(
        "refs/heads/feature/payment",
      );
      expect(await localGit("config", "branch.payment-review.rebase")).toBe("true");
      expect(await localGit("config", "branch.payment-review.description")).toBe(
        "Keep this description",
      );
      expect(await localGit("for-each-ref", "refs/remotes/")).toBe(remotes);
      expect((await git.run(["show-ref"], { gitDir: repository.remote })).stdout).toBe(remoteRefs);
      expect(
        await git.succeeds(["show-ref", "--verify", "--quiet", feature.branchRef ?? ""], {
          gitDir: workspace.gitDir,
        }),
      ).toBe(false);
      await expect(fs.lstat(feature.path)).rejects.toMatchObject({ code: "ENOENT" });
      if (dirty) {
        expect(await fs.readFile(path.join(moved.path, "local.bin"))).toEqual(
          Buffer.from([0, 255, 10]),
        );
        expect(await fs.readFile(path.join(moved.path, ".env"), "utf8")).toBe(
          "EXAMPLE_VALUE=preserved\n",
        );
        expect(await fs.readlink(path.join(moved.path, "readme-link"))).toBe("README.md");
      }
    },
  );

  it("supports a distinct branch with slashes and preserves a gone upstream", async () => {
    await localGit("update-ref", "-d", "refs/remotes/origin/feature/payment");
    const plan = await service.prepareMove(
      workspace,
      feature.name,
      "payment-review",
      workspace.root,
      { branch: "feature/payment-review" },
    );
    const moved = await service.move(workspace, plan);
    expect(moved.branch).toBe("feature/payment-review");
    expect(plan.branchChange.upstream).toBe("origin/feature/payment");
    expect(await localGit("config", "branch.feature/payment-review.merge")).toBe(
      "refs/heads/feature/payment",
    );
    expect(
      await git.succeeds(
        ["show-ref", "--verify", "--quiet", "refs/remotes/origin/feature/payment"],
        { gitDir: workspace.gitDir },
      ),
    ).toBe(false);
  });

  it("keeps the exact upstream even when the new local name shadows a remote tracking name", async () => {
    const plan = await service.prepareMove(
      workspace,
      feature.name,
      "payment-review",
      workspace.root,
      { branch: "origin/feature/payment" },
    );
    const moved = await service.move(workspace, plan);
    expect(moved.branch).toBe("origin/feature/payment");
    expect(plan.branchChange.upstream).toBe("origin/feature/payment");
    expect(
      await localGit("for-each-ref", "--format=%(upstream)", "refs/heads/origin/feature/payment"),
    ).toBe("refs/remotes/origin/feature/payment");
  });

  it("keeps an explicitly unchanged branch and permits a directory-only name that is not a Git ref", async () => {
    const plan = await service.prepareMove(
      workspace,
      feature.name,
      "payment-review",
      workspace.root,
      { branch: feature.branch ?? "" },
    );
    expect(plan.branchChange.renamed).toBe(false);
    const moved = await service.move(workspace, plan);
    const kept = await service.move(
      workspace,
      await service.prepareMove(workspace, moved.name, "review..ready", workspace.root, {
        keepBranch: true,
      }),
    );
    expect(kept.branch).toBe(feature.branch);
  });

  it("rejects a branch shared by multiple worktrees while allowing a directory-only rename", async () => {
    const other = path.join(workspace.root, "other-checkout");
    await localGit("worktree", "add", "--force", other, "feature/payment");
    await expect(
      service.prepareMove(workspace, feature.name, "payment-review", workspace.root),
    ).rejects.toThrow(/multiple worktrees/u);
    expect(await service.listMoveCandidates(workspace, workspace.root)).not.toContainEqual(
      expect.objectContaining({ path: feature.path }),
    );
    const moved = await service.move(
      workspace,
      await service.prepareMove(workspace, feature.name, "payment-review", workspace.root, {
        keepBranch: true,
      }),
    );
    expect(moved.branch).toBe(feature.branch);
    expect((await service.resolve(workspace, other)).branch).toBe(feature.branch);
  });

  it("rejects primary and unavailable worktrees before mutation", async () => {
    await expect(
      service.prepareMove(
        { ...workspace, primaryWorktree: feature.path },
        feature.name,
        "payment-review",
        workspace.root,
      ),
    ).rejects.toThrow(/primary checkout/u);
    const run = git.run.bind(git);
    vi.spyOn(git, "run").mockImplementation(async (args, options) => {
      if (args[0] === "status" && options?.cwd === feature.path)
        return { exitCode: 128, stdout: "", stderr: "unavailable" };
      return await run(args, options);
    });
    await expect(
      service.prepareMove(workspace, feature.name, "payment-review", workspace.root),
    ).rejects.toThrow(/state is unavailable/u);
    await expectOriginal();
  });

  it("rejects a replaced directory even when its branch, HEAD and Git link match the prepared plan", async () => {
    const plan = await service.prepareMove(
      workspace,
      feature.name,
      "payment-review",
      workspace.root,
    );
    const original = path.join(root, "preserved-original");
    await fs.rename(feature.path, original);
    await fs.cp(original, feature.path, { recursive: true });
    await fs.writeFile(path.join(feature.path, "concurrent.txt"), "preserve replacement\n");
    await expect(service.move(workspace, plan)).rejects.toThrow(
      /changed after rename preparation/u,
    );
    expect(await fs.readFile(path.join(feature.path, "concurrent.txt"), "utf8")).toBe(
      "preserve replacement\n",
    );
    expect(await fs.readFile(path.join(original, "README.md"), "utf8")).toBe("# fixture\n");
    await expectOriginal();
  });

  it("preserves an occupied original directory and restores the branch at the moved worktree", async () => {
    const plan = await service.prepareMove(
      workspace,
      feature.name,
      "payment-review",
      workspace.root,
    );
    const run = git.run.bind(git);
    let injected = false;
    vi.spyOn(git, "run").mockImplementation(async (args, options) => {
      const result = await run(args, options);
      if (!injected && args[0] === "worktree" && args[1] === "move") {
        injected = true;
        await fs.mkdir(feature.path);
        await fs.writeFile(path.join(feature.path, "concurrent.txt"), "preserve new directory\n");
        throw new Error("injected failure");
      }
      return result;
    });
    await expect(service.move(workspace, plan)).rejects.toThrow(
      /Rollback incomplete: Original path is occupied:[\s\S]*Recovery:/u,
    );
    expect(await fs.readFile(path.join(feature.path, "concurrent.txt"), "utf8")).toBe(
      "preserve new directory\n",
    );
    expect(await service.resolve(workspace, plan.target)).toMatchObject({
      branch: feature.branch,
      head: feature.head,
    });
  });

  it.each(["feature", "default", "detached"])(
    "keeps the %s branch with --keep-branch",
    async (kind) => {
      if (kind === "default")
        feature = await service.add(workspace, { branch: "main", fetch: false });
      if (kind === "detached") {
        await git.run(["checkout", "--detach"], { cwd: feature.path });
        feature = await service.resolve(workspace, feature.path);
      }
      const before = await snapshot(feature.path);
      const plan = await service.prepareMove(
        workspace,
        feature.name,
        "payment-review",
        workspace.root,
        { keepBranch: true },
      );
      const moved = await service.move(workspace, plan);
      expect(moved.branch).toBe(feature.branch);
      expect(plan.branchChange).toMatchObject({
        before: feature.branch,
        after: feature.branch,
        renamed: false,
      });
      expect(await snapshot(moved.path)).toEqual(before);
    },
  );

  it.each(["default", "detached"])(
    "requires --keep-branch for %s before any mutation",
    async (kind) => {
      if (kind === "default")
        feature = await service.add(workspace, { branch: "main", fetch: false });
      else {
        await git.run(["checkout", "--detach"], { cwd: feature.path });
        feature = await service.resolve(workspace, feature.path);
      }
      const before = await localGit("show-ref");
      for (const options of [{}, { branch: "feature/other" }]) {
        await expect(
          service.prepareMove(workspace, feature.name, "payment-review", workspace.root, options),
        ).rejects.toThrow(/require.*--keep-branch/u);
      }
      expect(await localGit("show-ref")).toBe(before);
      expect(await fs.stat(feature.path)).toSatisfy((stat) => stat.isDirectory());
      expect(await service.listMoveCandidates(workspace, workspace.root)).not.toContainEqual(
        expect.objectContaining({ path: feature.path }),
      );
      expect(
        await service.listMoveCandidates(workspace, workspace.root, { keepBranch: true }),
      ).toContainEqual(expect.objectContaining({ path: feature.path }));
    },
  );

  it.each([
    "bad..name",
    "bad name",
    "-option",
    "@{-1}",
    "feature/payment/child",
    "feature",
    "main",
  ])("rejects invalid or conflicting branch %s without moving or renaming", async (branch) => {
    const refs = await localGit("show-ref");
    await expect(
      service.prepareMove(workspace, feature.name, "payment-review", workspace.root, { branch }),
    ).rejects.toThrow(/branch name|already exists|conflicts/u);
    expect(await localGit("show-ref")).toBe(refs);
    await expectOriginal();
  });

  it("validates the default branch name and mutually exclusive options", async () => {
    await expect(
      service.prepareMove(workspace, feature.name, "bad..name", workspace.root),
    ).rejects.toThrow(/Invalid branch name/u);
    await expect(
      service.prepareMove(workspace, feature.name, "payment-review", workspace.root, {
        branch: "other",
        keepBranch: true,
      }),
    ).rejects.toThrow(/cannot be combined/u);
    await expectOriginal();
  });

  it("preserves orphaned target branch configuration before rejecting a rename", async () => {
    await localGit("config", "branch.payment-review.remote", "example-remote");
    await expect(
      service.prepareMove(workspace, feature.name, "payment-review", workspace.root),
    ).rejects.toThrow(/existing or unreadable configuration/u);
    expect(await localGit("config", "branch.payment-review.remote")).toBe("example-remote");
    await expectOriginal();
  });

  it.each(["head", "branch", "upstream", "destination", "collision", "lock"])(
    "rejects %s drift after preparation before mutation",
    async (change) => {
      const plan = await service.prepareMove(
        workspace,
        feature.name,
        "payment-review",
        workspace.root,
      );
      if (change === "head") {
        const commit = await localGit(
          "-c",
          "user.name=Example",
          "-c",
          "user.email=tests@example.invalid",
          "commit-tree",
          `${feature.head}^{tree}`,
          "-p",
          feature.head ?? "",
          "-m",
          "concurrent commit",
        );
        await localGit("update-ref", feature.branchRef ?? "", commit);
      }
      if (change === "branch") {
        await localGit("branch", "other", feature.head ?? "");
        await git.run(["symbolic-ref", "HEAD", "refs/heads/other"], { cwd: feature.path });
      }
      if (change === "upstream")
        await localGit("config", "branch.feature/payment.merge", "refs/heads/main");
      if (change === "destination") await fs.mkdir(plan.target);
      if (change === "collision") await localGit("branch", "payment-review", feature.head ?? "");
      if (change === "lock") await localGit("worktree", "lock", feature.path);
      const refs = await localGit("show-ref");
      const config = await fs.readFile(path.join(workspace.gitDir, "config"));
      const run = vi.spyOn(git, "run");
      await expect(service.move(workspace, plan)).rejects.toThrow();
      expect(
        run.mock.calls.some(
          ([args]) =>
            (args[0] === "branch" && args[1] === "--move") ||
            (args[0] === "worktree" && args[1] === "move"),
        ),
      ).toBe(false);
      expect(await localGit("show-ref")).toBe(refs);
      expect(await fs.readFile(path.join(workspace.gitDir, "config"))).toEqual(config);
      expect(await fs.stat(feature.path)).toSatisfy((stat) => stat.isDirectory());
    },
  );

  it.each(["before move", "after move", "after branch rename", "verification"])(
    "rolls back a failure %s and preserves dirty work",
    async (failure) => {
      await fs.writeFile(path.join(feature.path, "README.md"), "# staged\n");
      await git.run(["add", "README.md"], { cwd: feature.path });
      await fs.appendFile(path.join(feature.path, "README.md"), "unstaged\n");
      const before = await snapshot(feature.path);
      const plan = await service.prepareMove(
        workspace,
        feature.name,
        "payment-review",
        workspace.root,
      );
      const run = git.run.bind(git);
      let injected = false;
      vi.spyOn(git, "run").mockImplementation(async (args, options) => {
        const move = args[0] === "worktree" && args[1] === "move";
        const branch = args[0] === "branch" && args[1] === "--move";
        const verification =
          failure === "verification" && options?.cwd === plan.target && args[0] === "status";
        if (
          !injected &&
          ((move && failure !== "after branch rename" && failure !== "verification") ||
            (branch && failure === "after branch rename") ||
            verification)
        ) {
          injected = true;
          if (failure === "after move" || failure === "after branch rename")
            await run(args, options);
          throw new Error("injected failure");
        }
        return await run(args, options);
      });

      await expect(service.move(workspace, plan)).rejects.toThrow(
        /original worktree path and branch restored: injected failure/u,
      );
      expect(injected).toBe(true);
      await expectOriginal();
      expect(await snapshot(feature.path)).toEqual(before);
      expect(await localGit("config", "branch.feature/payment.merge")).toBe(
        "refs/heads/feature/payment",
      );
    },
  );

  it("restores the branch even when the directory cannot be rolled back", async () => {
    const plan = await service.prepareMove(
      workspace,
      feature.name,
      "payment-review",
      workspace.root,
    );
    const run = git.run.bind(git);
    vi.spyOn(git, "run").mockImplementation(async (args, options) => {
      if (args[0] === "worktree" && args[1] === "move") {
        if (args[2] === feature.path) await run(args, options);
        throw new Error("injected move failure");
      }
      return await run(args, options);
    });
    await expect(service.move(workspace, plan)).rejects.toThrow(
      /Rollback incomplete:[\s\S]*Recovery:[\s\S]*git worktree move/u,
    );
    expect(await service.resolve(workspace, plan.target)).toMatchObject({
      branch: feature.branch,
      head: feature.head,
    });
    expect(await localGit("config", "branch.feature/payment.merge")).toBe(
      "refs/heads/feature/payment",
    );
    await expect(fs.stat(feature.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["head", "upstream", "occupied branch"])(
    "refuses unsafe rollback after concurrent %s changes",
    async (change) => {
      const plan = await service.prepareMove(
        workspace,
        feature.name,
        "payment-review",
        workspace.root,
      );
      const run = git.run.bind(git);
      let injected = false;
      vi.spyOn(git, "run").mockImplementation(async (args, options) => {
        if (!injected && args[0] === "worktree" && args[1] === "move") {
          injected = true;
          if (change === "head") {
            const commit = await localGit(
              "-c",
              "user.name=Example",
              "-c",
              "user.email=tests@example.invalid",
              "commit-tree",
              `${feature.head}^{tree}`,
              "-p",
              feature.head ?? "",
              "-m",
              "concurrent commit",
            );
            await localGit("update-ref", "refs/heads/payment-review", commit);
          }
          if (change === "upstream")
            await localGit("config", "branch.payment-review.merge", "refs/heads/main");
          if (change === "occupied branch")
            await localGit("branch", "feature/payment", feature.head ?? "");
          throw new Error("injected concurrent change");
        }
        return await run(args, options);
      });
      await expect(service.move(workspace, plan)).rejects.toThrow(
        /Rollback incomplete:[\s\S]*Recovery:[\s\S]*Do not force/u,
      );
      expect((await service.resolve(workspace, feature.path)).branch).toBe("payment-review");
      if (change === "head")
        expect(await localGit("rev-parse", "refs/heads/payment-review")).not.toBe(feature.head);
      if (change === "upstream")
        expect(await localGit("config", "branch.payment-review.merge")).toBe("refs/heads/main");
      if (change === "occupied branch")
        expect(await localGit("rev-parse", "refs/heads/feature/payment")).toBe(feature.head);
    },
  );
});
