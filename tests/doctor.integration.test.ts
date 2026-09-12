import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliContext } from "../src/cli/context.js";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

describe("doctor", { timeout: 15_000 }, () => {
  let temporaryRoot: string;
  let repository: TestRepository;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wald-doctor-test-"));
    repository = await createTestRepository(temporaryRoot);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("reports a missing workspace as a non-failing warning", async () => {
    const report = await createCliContext().doctor.inspect(temporaryRoot);

    expect(report.status).toBe("warning");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "workspace.discovery", status: "warning" }),
    );
    expect(report.checks.some((check) => check.status === "fail")).toBe(false);
  });

  it("reports invalid workspace YAML without throwing", async () => {
    const metadata = path.join(temporaryRoot, ".wald");
    await fs.mkdir(metadata);
    await fs.writeFile(
      path.join(metadata, "workspace.yml"),
      "remote: https://secret.example/repository.git\nversion: [\n",
      "utf8",
    );

    const report = await createCliContext().doctor.inspect(temporaryRoot);

    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "workspace.configuration", status: "fail" }),
    );
    expect(JSON.stringify(report)).not.toContain("secret.example");
  });

  it("inspects a healthy workspace without changing configuration or refs", async () => {
    const workspaceRoot = path.join(temporaryRoot, "workspace");
    const context = createCliContext();
    const workspace = await context.workspaces.initialize(repository.remote, workspaceRoot);
    const configBefore = await fs.readFile(workspace.configPath, "utf8");
    const refsBefore = await context.git.run(
      ["for-each-ref", "--format=%(refname) %(objectname)"],
      {
        gitDir: workspace.gitDir,
      },
    );
    const previousSecret = process.env.WALD_DOCTOR_TEST_SECRET;
    process.env.WALD_DOCTOR_TEST_SECRET = "doctor-secret-value";
    try {
      const report = await context.doctor.inspect(workspaceRoot);
      const serialized = JSON.stringify(report);

      expect(report.status).toBe("pass");
      expect(report.checks).toContainEqual(
        expect.objectContaining({ id: "git.common-directory", status: "pass" }),
      );
      expect(serialized).not.toContain(repository.remote);
      expect(serialized).not.toContain("doctor-secret-value");
    } finally {
      if (previousSecret === undefined) delete process.env.WALD_DOCTOR_TEST_SECRET;
      else process.env.WALD_DOCTOR_TEST_SECRET = previousSecret;
    }
    expect(await fs.readFile(workspace.configPath, "utf8")).toBe(configBefore);
    expect(
      await context.git.run(["for-each-ref", "--format=%(refname) %(objectname)"], {
        gitDir: workspace.gitDir,
      }),
    ).toEqual(refsBefore);
  });

  it("suggests pruning for a missing worktree while preserving its registration", async () => {
    const workspaceRoot = path.join(temporaryRoot, "workspace");
    const context = createCliContext();
    const workspace = await context.workspaces.initialize(repository.remote, workspaceRoot);
    const created = await context.worktrees.add(workspace, { branch: "main", fetch: false });
    await fs.rm(created.path, { recursive: true });
    const registrationsBefore = await context.git.run(["worktree", "list", "--porcelain", "-z"], {
      gitDir: workspace.gitDir,
    });

    const report = await context.doctor.inspect(workspaceRoot);

    expect(report.status).toBe("warning");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "git.worktrees",
        status: "warning",
        suggestion: "Preview safe cleanup with wald prune.",
      }),
    );
    expect(
      await context.git.run(["worktree", "list", "--porcelain", "-z"], {
        gitDir: workspace.gitDir,
      }),
    ).toEqual(registrationsBefore);
  });

  it("treats an intentionally locked unavailable location as informational", async () => {
    const workspaceRoot = path.join(temporaryRoot, "workspace");
    const context = createCliContext();
    const workspace = await context.workspaces.initialize(repository.remote, workspaceRoot);
    const created = await context.worktrees.add(workspace, { branch: "main", fetch: false });
    await context.git.run(["worktree", "lock", "--reason", "portable", created.path], {
      gitDir: workspace.gitDir,
    });
    await fs.rm(created.path, { recursive: true });

    const report = await context.doctor.inspect(workspaceRoot);

    expect(report.status).toBe("pass");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "git.worktree-locks",
        status: "pass",
        summary: expect.stringContaining("1 worktree is intentionally locked"),
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "git.worktrees", status: "pass" }),
    );
  });

  it("reports trust, missing file sources, and unavailable executables without exposing env", async () => {
    const workspaceRoot = path.join(temporaryRoot, "workspace");
    const context = createCliContext();
    const workspace = await context.workspaces.initialize(repository.remote, workspaceRoot);
    const main = await context.worktrees.add(workspace, { branch: "main", fetch: false });
    await fs.writeFile(
      path.join(workspaceRoot, ".wald", "project.yml"),
      `version: 1
hooks:
  post_create:
    - type: command
      argv: [definitely-missing-wald-command]
      env:
        API_TOKEN: doctor-secret-value
    - type: copy
      source: shared
      from: missing.env
      to: .env
tools:
  unavailable:
    command: [definitely-missing-wald-tool]
`,
      "utf8",
    );

    const report = await context.doctor.inspect(main.path);
    const serialized = JSON.stringify(report);

    expect(report.status).toBe("fail");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "project.trust", status: "warning" }),
        expect.objectContaining({ id: "git.invocation-context", status: "pass" }),
        expect.objectContaining({ id: "project.executables", status: "warning" }),
        expect.objectContaining({ id: "project.file-sources", status: "fail" }),
      ]),
    );
    expect(serialized).not.toContain("doctor-secret-value");
  });
});
