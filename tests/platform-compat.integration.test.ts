import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliContext } from "../src/cli/context.js";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

describe("macOS and Linux filesystem compatibility", { timeout: 15_000 }, () => {
  let temporaryRoot: string;
  let repository: TestRepository;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-platform-test-"));
    repository = await createTestRepository(temporaryRoot);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("uses canonical paths through spaces, Unicode, and a workspace symlink", async () => {
    const context = createCliContext();
    const root = path.join(temporaryRoot, "Wörk space");
    const workspace = await context.workspaces.initialize(repository.remote, root);
    const main = await context.worktrees.add(workspace, {
      branch: "main",
      name: "Main Tree",
      fetch: false,
    });
    const feature = await context.worktrees.add(workspace, {
      branch: "feature/über",
      name: "Feature Ü Space",
      fetch: false,
    });
    const alias = path.join(temporaryRoot, "workspace alias");
    await fs.symlink(root, alias);

    expect(main.path).toBe(path.join(await fs.realpath(root), "Main Tree"));
    expect(feature.path).toBe(path.join(await fs.realpath(root), "Feature Ü Space"));
    await expect(
      context.workspaces.find(path.join(alias, "Feature Ü Space")),
    ).resolves.toMatchObject({
      root: await fs.realpath(root),
    });
  });

  it("rejects directory names that collide on case-insensitive filesystems", async () => {
    const context = createCliContext();
    const workspace = await context.workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "workspace"),
    );
    await context.worktrees.add(workspace, {
      branch: "feature/one",
      name: "Review Tree",
      fetch: false,
    });

    await expect(
      context.worktrees.prepareAdd(workspace, {
        branch: "feature/two",
        name: "review tree",
        fetch: false,
      }),
    ).rejects.toThrow(/case-insensitively|already exists/u);
  });

  it.runIf(process.platform !== "win32")(
    "reports inaccessible configured directories without mutating permissions",
    async () => {
      const context = createCliContext();
      const workspace = await context.workspaces.initialize(
        repository.remote,
        path.join(temporaryRoot, "workspace"),
        temporaryRoot,
        { worktreeDir: "worktrees" },
      );
      await fs.chmod(workspace.worktreeDir, 0o000);
      try {
        const report = await context.doctor.inspect(workspace.root);
        expect(report.status).toBe("fail");
        expect(report.checks).toContainEqual(
          expect.objectContaining({ id: "paths.worktrees", status: "fail" }),
        );
        expect((await fs.stat(workspace.worktreeDir)).mode & 0o777).toBe(0);
      } finally {
        await fs.chmod(workspace.worktreeDir, 0o700);
      }
    },
  );
});
