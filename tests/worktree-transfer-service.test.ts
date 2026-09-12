import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitClient } from "../src/infrastructure/git-client.js";
import { WorktreeTransferService } from "../src/services/worktree-transfer-service.js";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

describe("worktree change transfer", () => {
  let temporaryRoot: string;
  let repository: TestRepository;
  let git: GitClient;
  let transfers: WorktreeTransferService;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wald-transfer-test-"));
    repository = await createTestRepository(temporaryRoot);
    git = new GitClient();
    transfers = new WorktreeTransferService(git);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("preserves staged, unstaged, binary, executable, untracked, and symlink state", async () => {
    const executable = path.join(repository.source, "script.sh");
    const deleted = path.join(repository.source, "deleted.txt");
    await fs.writeFile(executable, "#!/bin/sh\necho original\n", { mode: 0o755 });
    await fs.writeFile(deleted, "delete me\n", "utf8");
    await git.run(["add", "script.sh", "deleted.txt"], { cwd: repository.source });
    await git.run(["commit", "-m", "add transfer fixtures"], { cwd: repository.source });

    await fs.writeFile(path.join(repository.source, "README.md"), "# staged\n", "utf8");
    await fs.writeFile(executable, "#!/bin/sh\necho staged\n", { mode: 0o755 });
    await git.run(["add", "README.md", "script.sh"], { cwd: repository.source });
    await fs.appendFile(path.join(repository.source, "README.md"), "unstaged\n", "utf8");
    await fs.rm(deleted);
    await fs.writeFile(path.join(repository.source, "binary.dat"), Buffer.from([0, 1, 2, 255]));
    await fs.symlink("README.md", path.join(repository.source, "readme-link"));
    await fs.writeFile(path.join(repository.source, ".env"), "SECRET=kept-in-source\n", "utf8");

    const sourceStatusBefore = await git.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repository.source, stripFinalNewline: false },
    );
    const snapshot = await transfers.capture(repository.source);
    const target = path.join(temporaryRoot, "carried");
    await git.run(["worktree", "add", "-b", "feature/carried", target, snapshot.head], {
      cwd: repository.source,
    });

    await transfers.apply(snapshot, target);

    const targetStatus = await git.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: target, stripFinalNewline: false },
    );
    const sourceStatusAfter = await git.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repository.source, stripFinalNewline: false },
    );
    expect(targetStatus.stdout).toBe(sourceStatusBefore.stdout);
    expect(sourceStatusAfter.stdout).toBe(sourceStatusBefore.stdout);
    expect(snapshot.summary).toEqual({ staged: 2, unstaged: 2, untracked: 2 });
    expect(await fs.readFile(path.join(target, "README.md"), "utf8")).toBe("# staged\nunstaged\n");
    expect(await fs.readFile(path.join(target, "binary.dat"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await fs.readlink(path.join(target, "readme-link"))).toBe("README.md");
    expect((await fs.stat(path.join(target, "script.sh"))).mode & 0o111).not.toBe(0);
    await expect(fs.stat(path.join(target, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects sparse checkouts before capturing any changes", async () => {
    await git.run(["config", "core.sparseCheckout", "true"], { cwd: repository.source });

    await expect(transfers.capture(repository.source)).rejects.toThrow(/sparse checkout/u);
  });

  it("preserves staged renames and tracked binary patches", async () => {
    await fs.writeFile(path.join(repository.source, "old-name.txt"), "renamed\n", "utf8");
    await fs.writeFile(path.join(repository.source, "tracked.bin"), Buffer.from([0, 1, 2, 3]));
    await git.run(["add", "old-name.txt", "tracked.bin"], { cwd: repository.source });
    await git.run(["commit", "-m", "add rename and binary fixtures"], {
      cwd: repository.source,
    });
    await git.run(["mv", "old-name.txt", "new-name.txt"], { cwd: repository.source });
    await fs.writeFile(path.join(repository.source, "tracked.bin"), Buffer.from([0, 4, 255, 3]));
    await git.run(["add", "tracked.bin"], { cwd: repository.source });

    const snapshot = await transfers.capture(repository.source);
    const target = path.join(temporaryRoot, "renamed-and-binary");
    await git.run(["worktree", "add", "-b", "feature/renamed-binary", target, snapshot.head], {
      cwd: repository.source,
    });
    await transfers.apply(snapshot, target);

    await expect(fs.stat(path.join(target, "old-name.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(target, "new-name.txt"), "utf8")).toBe("renamed\n");
    expect(await fs.readFile(path.join(target, "tracked.bin"))).toEqual(
      Buffer.from([0, 4, 255, 3]),
    );
    expect((await git.run(["status", "--porcelain=v1"], { cwd: target })).stdout).toBe(
      (await git.run(["status", "--porcelain=v1"], { cwd: repository.source })).stdout,
    );
  });

  it("rejects active Git operations and submodule index changes", async () => {
    const mergeHeadGitPath = (
      await git.run(["rev-parse", "--git-path", "MERGE_HEAD"], { cwd: repository.source })
    ).stdout;
    const mergeHead = path.resolve(repository.source, mergeHeadGitPath);
    await fs.writeFile(mergeHead, `${"0".repeat(40)}\n`, "utf8");
    await expect(transfers.capture(repository.source)).rejects.toThrow(/active Git operation/u);
    await fs.rm(mergeHead);

    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repository.source })).stdout;
    await git.run(["update-index", "--add", "--cacheinfo", `160000,${head},vendor/module`], {
      cwd: repository.source,
    });
    await expect(transfers.capture(repository.source)).rejects.toThrow(/submodule changes/u);
  });

  it("detects source drift during application", async () => {
    await fs.writeFile(path.join(repository.source, "local.txt"), "initial\n", "utf8");
    const snapshot = await transfers.capture(repository.source);
    const target = path.join(temporaryRoot, "drift-target");
    await git.run(["worktree", "add", "-b", "feature/drift", target, snapshot.head], {
      cwd: repository.source,
    });
    const capture = transfers.capture.bind(transfers);
    vi.spyOn(transfers, "capture").mockImplementationOnce(async (sourcePath) => {
      await fs.writeFile(path.join(sourcePath, "drift.txt"), "changed during carry\n", "utf8");
      return await capture(sourcePath);
    });

    await expect(transfers.apply(snapshot, target)).rejects.toThrow(
      /source worktree changed while its local changes were being carried/u,
    );
  });
});
