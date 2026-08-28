import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/infrastructure/git-client.js";
import { ProcessRunner } from "../src/infrastructure/process-runner.js";
import { AutomationService } from "../src/services/automation-service.js";
import { ConfigService } from "../src/services/config-service.js";
import { WorkspaceService } from "../src/services/workspace-service.js";
import { WorktreeService } from "../src/services/worktree-service.js";
import { WorktreeWorkflowService } from "../src/services/worktree-workflow-service.js";
import { AutomationReporter } from "../src/ui/automation-reporter.js";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

describe("configured worktree workflows", () => {
  let temporaryRoot: string;
  let repository: TestRepository;
  let git: GitClient;
  let configs: ConfigService;
  let workspaces: WorkspaceService;
  let worktrees: WorktreeService;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-workflow-test-"));
    repository = await createTestRepository(temporaryRoot);
    git = new GitClient();
    configs = new ConfigService();
    workspaces = new WorkspaceService(git, configs);
    worktrees = new WorktreeService(git);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("requires trust, then runs lifecycle hooks, file steps, and named tasks", async () => {
    await commitProjectConfig(
      repository,
      `version: 1
defaults:
  fetch: false
hooks:
  pre_create:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync(process.env.YGG_WORKSPACE_ROOT + '/pre-create.log', process.env.YGG_BRANCH)"]
      cwd: workspace
  post_create:
    - type: copy
      source: default
      from: config.example
      to: config.local
    - type: symlink
      source: default
      from: shared.txt
      to: linked-shared.txt
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('post-create.log', process.env.YGG_EVENT)"]
  pre_remove:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync(process.env.YGG_WORKSPACE_ROOT + '/pre-remove.log', process.env.YGG_BRANCH)"]
  post_remove:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('post-remove.log', process.env.YGG_EVENT)"]
      cwd: workspace
tasks:
  verify:
    description: Run the project check
    steps:
      - type: command
        argv: [node, -e, "require('node:fs').writeFileSync('task.log', process.env.YGG_EVENT); console.log('child-output')"]
        env:
          SECRET_VALUE: do-not-print
  continue:
    steps:
      - type: command
        shell: exit 9
        continue_on_error: true
      - type: command
        argv: [node, -e, "require('node:fs').writeFileSync('continued.log', 'yes')"]
`,
      {
        "config.example": "EXAMPLE=true\n",
        "shared.txt": "shared\n",
      },
    );
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "workspace"),
    );
    const workflow = createWorkflow(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, { branch: "main" });

    expect(plan.trusted).toBe(false);
    await expect(workflow.executeCreate(plan)).rejects.toThrow(/not trusted/u);
    expect(await worktrees.list(workspace)).toEqual([]);

    if (!plan.project) throw new Error("Expected project configuration.");
    await configs.trust(workspace, plan.project);
    const lifecycleOutput = new PassThrough();
    const created = await workflow.executeCreate(plan, { output: lifecycleOutput });
    const renderedLifecycle = readOutput(lifecycleOutput);
    expect(renderedLifecycle).toContain("Hook        pre_create");
    expect(renderedLifecycle).toContain("\n\nHook        post_create");
    expect(renderedLifecycle).toContain("\n\n2     RUNNING");
    expect(renderedLifecycle).toContain("\n\n3     RUNNING");

    expect(await fs.readFile(path.join(workspace.root, "pre-create.log"), "utf8")).toBe("main");
    expect(await fs.readFile(path.join(created.path, "config.local"), "utf8")).toBe(
      "EXAMPLE=true\n",
    );
    expect(await fs.readlink(path.join(created.path, "linked-shared.txt"))).toBe("shared.txt");
    expect(await fs.readFile(path.join(created.path, "post-create.log"), "utf8")).toBe(
      "post_create",
    );

    const taskOutput = new PassThrough();
    await workflow.runTask(workspace, created, "verify", { output: taskOutput });
    expect(await fs.readFile(path.join(created.path, "task.log"), "utf8")).toBe("task:verify");
    const renderedTask = readOutput(taskOutput);
    expect(renderedTask).toContain("Task        verify");
    expect(renderedTask).toContain(`Worktree    ${created.name}`);
    expect(renderedTask).toContain(`Path        ${created.path}`);
    expect(renderedTask).toMatch(/1\s+RUNNING\s+command\s+node -e/u);
    expect(renderedTask).toMatch(/1\s+DONE\s+command\s+node -e/u);
    expect(renderedTask.indexOf("RUNNING")).toBeLessThan(renderedTask.indexOf("child-output"));
    expect(renderedTask.indexOf("child-output")).toBeLessThan(renderedTask.indexOf("DONE"));
    expect(renderedTask).not.toContain("do-not-print");

    const continuedOutput = new PassThrough();
    await workflow.runTask(workspace, created, "continue", { output: continuedOutput });
    const renderedContinued = readOutput(continuedOutput);
    expect(renderedContinued).toMatch(/1\s+FAILED\s+command/u);
    expect(renderedContinued).toContain("continuing");
    expect(renderedContinued).toMatch(/2\s+DONE\s+command/u);
    expect(await fs.readFile(path.join(created.path, "continued.log"), "utf8")).toBe("yes");

    for (const generated of [
      "config.local",
      "linked-shared.txt",
      "post-create.log",
      "task.log",
      "continued.log",
    ]) {
      await fs.rm(path.join(created.path, generated), { force: true });
    }
    const removal = await workflow.planRemove(workspace, created.name);
    await workflow.executeRemove(removal);

    expect(await fs.readFile(path.join(workspace.root, "pre-remove.log"), "utf8")).toBe("main");
    expect(await fs.readFile(path.join(workspace.root, "post-remove.log"), "utf8")).toBe(
      "post_remove",
    );
    expect(await worktrees.list(workspace)).toEqual([]);
  });

  it("deletes an explicitly selected merged local branch after its worktree", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "branch-cleanup-workspace"),
    );
    const workflow = createWorkflow(git, worktrees, configs);
    await workflow.executeCreate(
      await workflow.planCreate(workspace, { branch: "main", fetch: false }),
    );
    const feature = await workflow.executeCreate(
      await workflow.planCreate(workspace, { branch: "feature/cleanup", fetch: false }),
    );

    const removal = await workflow.planRemove(workspace, feature.name);
    expect(removal.inspection.branchDeletion).toMatchObject({
      eligible: true,
      branch: "feature/cleanup",
      branchRef: "refs/heads/feature/cleanup",
      expectedHead: feature.head,
    });
    await workflow.executeRemove(removal, { deleteBranch: true });

    await expect(fs.stat(feature.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await git.succeeds(["show-ref", "--verify", "--quiet", "refs/heads/feature/cleanup"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(false);
    expect(
      await git.succeeds(["show-ref", "--verify", "--quiet", "refs/heads/main"], {
        gitDir: workspace.gitDir,
      }),
    ).toBe(true);
  });

  it("refuses explicit deletion of an unmerged branch before removing its worktree", async () => {
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "unmerged-cleanup-workspace"),
    );
    const workflow = createWorkflow(git, worktrees, configs);
    await workflow.executeCreate(
      await workflow.planCreate(workspace, { branch: "main", fetch: false }),
    );
    const feature = await workflow.executeCreate(
      await workflow.planCreate(workspace, { branch: "feature/unmerged-cleanup", fetch: false }),
    );
    await git.run(["config", "user.email", "tests@example.invalid"], { cwd: feature.path });
    await git.run(["config", "user.name", "ygg tests"], { cwd: feature.path });
    await fs.writeFile(path.join(feature.path, "feature.txt"), "unmerged\n", "utf8");
    await git.run(["add", "feature.txt"], { cwd: feature.path });
    await git.run(["commit", "-m", "unmerged feature"], { cwd: feature.path });

    const removal = await workflow.planRemove(workspace, feature.name);
    expect(removal.inspection.branchDeletion).toMatchObject({
      eligible: false,
      reason: "the branch is not merged into main",
    });
    await expect(
      workflow.executeRemove(removal, { deleteBranch: true, force: true }),
    ).rejects.toThrow(/Cannot delete the local branch[\s\S]*not merged into main/u);

    await expect(fs.stat(feature.path)).resolves.toSatisfy((stat) => stat.isDirectory());
    expect(
      await git.succeeds(
        ["show-ref", "--verify", "--quiet", "refs/heads/feature/unmerged-cleanup"],
        { gitDir: workspace.gitDir },
      ),
    ).toBe(true);
  });

  it("applies one workspace-local overlay to repository behavior during creation and tasks", async () => {
    await commitProjectConfig(
      repository,
      `version: 1
hooks:
  post_create:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('base.log', 'base')"]
tasks:
  inherited:
    steps:
      - type: command
        argv: [node, --version]
  removed:
    steps:
      - type: command
        argv: [node, --version]
`,
    );
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "overlay-workspace"),
    );
    const overlay = configs.parseWorkspaceProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: command
      argv: [node, -e, "require('node:fs').writeFileSync('local.log', 'local')"]
tasks:
  removed: null
  local:
    steps:
      - type: command
        argv: [node, -e, "require('node:fs').writeFileSync('task.log', 'local')"]
`,
      path.join(workspace.root, ".ygg", "project.yml"),
    ).config;
    await configs.writeWorkspaceProjectConfig(workspace, overlay);
    const workflow = createWorkflow(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, { branch: "main", fetch: false });

    expect(plan.project?.sources.repository).toBe("refs/heads/main:.ygg.yml");
    expect(plan.project?.sources.workspace).toBe(path.join(workspace.root, ".ygg", "project.yml"));
    expect(Object.keys(plan.project?.config.tasks ?? {})).toEqual(["inherited", "local"]);
    if (!plan.project) throw new Error("Expected effective project configuration.");
    await configs.trust(workspace, plan.project);
    const created = await workflow.executeCreate(plan);

    await expect(fs.stat(path.join(created.path, "base.log"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(created.path, "local.log"), "utf8")).toBe("local");
    await workflow.runTask(workspace, created, "local");
    expect(await fs.readFile(path.join(created.path, "task.log"), "utf8")).toBe("local");
  });

  it("keeps a created worktree when post-create setup fails", async () => {
    await commitProjectConfig(
      repository,
      `version: 1
hooks:
  post_create:
    - type: command
      shell: |
        exit 23
`,
    );
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "failed-workspace"),
    );
    const workflow = createWorkflow(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, { branch: "main", fetch: false });
    if (!plan.project) throw new Error("Expected project configuration.");
    await configs.trust(workspace, plan.project);

    const output = new PassThrough();
    await expect(workflow.executeCreate(plan, { output })).rejects.toThrow(
      /Worktree was created[\s\S]*Retry with: ygg setup/u,
    );
    const rendered = readOutput(output);
    expect(rendered).toContain("Hook        post_create");
    expect(rendered).toMatch(/1\s+RUNNING\s+command\s+\/bin\/sh -c "exit 23\\\\x0a"/u);
    expect(rendered).toMatch(/1\s+FAILED\s+command/u);
    expect(rendered).toContain("exit code 23");
    await expect(worktrees.resolve(workspace, "main")).resolves.toMatchObject({ branch: "main" });
  });

  it("links and copies workspace-local shared files without escaping the shared root", async () => {
    await commitProjectConfig(
      repository,
      `version: 1
defaults:
  fetch: false
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env
    - type: symlink
      source: shared
      from: env/apps/api/.env
      to: apps/api/.env
    - type: copy
      source: shared
      from: config/tool.json
      to: .local/tool.json
tasks:
  link-local:
    steps:
      - type: symlink
        source: shared
        from: env/.env
        to: .env
  skip-link:
    steps:
      - type: symlink
        source: shared
        from: env/.env
        to: .env
        on_existing: skip
  replace-link:
    steps:
      - type: symlink
        source: shared
        from: env/.env
        to: .env
        on_existing: replace
  skip-local:
    steps:
      - type: copy
        source: shared
        from: config/tool.json
        to: .local/tool.json
        on_existing: skip
  sync-local:
    steps:
      - type: copy
        source: shared
        from: config/tool.json
        to: .local/tool.json
        overwrite: true
  escape:
    steps:
      - type: copy
        source: shared
        from: escape
        to: escaped.txt
  traversal:
    steps:
      - type: copy
        source: shared
        from: ../outside-secret
        to: escaped.txt
  optional-local:
    steps:
      - type: copy
        source: shared
        from: missing.txt
        to: optional.txt
        optional: true
  optional-unavailable:
    steps:
      - type: symlink
        source: primary
        from: .env
        to: unavailable.env
        optional: true
  directory-conflict:
    steps:
      - type: copy
        source: shared
        from: config/tool.json
        to: .local/conflict
`,
    );
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "shared-workspace"),
    );
    await fs.mkdir(path.join(workspace.sharedDir, "env", "apps", "api"), { recursive: true });
    await fs.mkdir(path.join(workspace.sharedDir, "config"), { recursive: true });
    await fs.writeFile(path.join(workspace.sharedDir, "env", ".env"), "ROOT=true\n", "utf8");
    await fs.writeFile(
      path.join(workspace.sharedDir, "env", "apps", "api", ".env"),
      "API=true\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace.sharedDir, "config", "tool.json"),
      '{"version":1}\n',
      "utf8",
    );

    const workflow = createWorkflow(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, { branch: "main", fetch: false });
    if (!plan.project) throw new Error("Expected project configuration.");
    await configs.trust(workspace, plan.project);
    const createOutput = new PassThrough();
    const created = await workflow.executeCreate(plan, { output: createOutput });

    const renderedCreate = readOutput(createOutput);
    expect(renderedCreate).toContain("Hook        post_create");
    expect(renderedCreate).toContain("STEP  STATUS");
    expect(renderedCreate.match(/RUNNING\s+(?:symlink|copy)/gu)).toHaveLength(3);
    expect(renderedCreate.indexOf("RUNNING")).toBeLessThan(renderedCreate.indexOf("CREATED"));
    expect(renderedCreate).toMatch(/1\s+CREATED\s+symlink\s+shared:env\/\.env\s+target:\.env/u);
    expect(renderedCreate).toMatch(
      /2\s+CREATED\s+symlink\s+shared:env\/apps\/api\/\.env\s+target:apps\/api\/\.env/u,
    );
    expect(renderedCreate).toMatch(
      /3\s+CREATED\s+copy\s+shared:config\/tool\.json\s+target:\.local\/tool\.json/u,
    );

    const rootLink = await fs.readlink(path.join(created.path, ".env"));
    expect(path.isAbsolute(rootLink)).toBe(false);
    expect(await fs.readFile(path.join(created.path, ".env"), "utf8")).toBe("ROOT=true\n");
    expect(await fs.readFile(path.join(created.path, "apps", "api", ".env"), "utf8")).toBe(
      "API=true\n",
    );
    expect(await fs.readFile(path.join(created.path, ".local", "tool.json"), "utf8")).toBe(
      '{"version":1}\n',
    );
    const rerunOutput = new PassThrough();
    await expect(
      workflow.runHook(workspace, created, "post_create", { output: rerunOutput }),
    ).rejects.toThrow(
      /Automation step 3 \(copy target:\.local\/tool\.json\) failed[\s\S]*on_existing/u,
    );
    const renderedRerun = readOutput(rerunOutput);
    expect(renderedRerun).toMatch(/1\s+UNCHANGED\s+symlink[\s\S]*already linked/u);
    expect(renderedRerun).toMatch(/2\s+UNCHANGED\s+symlink[\s\S]*already linked/u);
    expect(renderedRerun).toMatch(
      /3\s+FAILED\s+copy[\s\S]*target:\.local\/tool\.json[\s\S]*on_existing/u,
    );

    const unchangedOutput = new PassThrough();
    await workflow.runTask(workspace, created, "link-local", { output: unchangedOutput });
    expect(readOutput(unchangedOutput)).toMatch(/1\s+UNCHANGED\s+symlink[\s\S]*already linked/u);

    await fs.rm(path.join(created.path, ".env"));
    await fs.symlink("missing.env", path.join(created.path, ".env"));
    const conflictOutput = new PassThrough();
    await expect(
      workflow.runTask(workspace, created, "link-local", { output: conflictOutput }),
    ).rejects.toThrow(/Target target:\.env already exists/u);
    expect(readOutput(conflictOutput)).toMatch(/1\s+FAILED\s+symlink[\s\S]*Target[\s\S]*exists/u);
    expect(await fs.readlink(path.join(created.path, ".env"))).toBe("missing.env");

    const skipLinkOutput = new PassThrough();
    await workflow.runTask(workspace, created, "skip-link", { output: skipLinkOutput });
    expect(readOutput(skipLinkOutput)).toMatch(/1\s+SKIPPED\s+symlink[\s\S]*target exists/u);
    expect(await fs.readlink(path.join(created.path, ".env"))).toBe("missing.env");

    const replaceLinkOutput = new PassThrough();
    await workflow.runTask(workspace, created, "replace-link", { output: replaceLinkOutput });
    expect(readOutput(replaceLinkOutput)).toMatch(/1\s+REPLACED\s+symlink[\s\S]*existing target/u);
    expect(await fs.readFile(path.join(created.path, ".env"), "utf8")).toBe("ROOT=true\n");
    const optionalOutput = new PassThrough();
    await workflow.runTask(workspace, created, "optional-local", { output: optionalOutput });
    expect(readOutput(optionalOutput)).toMatch(
      /1\s+SKIPPED\s+copy\s+shared:missing\.txt\s+target:optional\.txt\s+source not found/u,
    );
    const unavailableOutput = new PassThrough();
    await workflow.runTask(workspace, created, "optional-unavailable", {
      output: unavailableOutput,
    });
    expect(readOutput(unavailableOutput)).toMatch(
      /1\s+SKIPPED\s+symlink\s+primary:\.env\s+target:unavailable\.env\s+source unavailable/u,
    );
    await expect(fs.stat(path.join(created.path, "optional.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(workflow.runTask(workspace, created, "traversal")).rejects.toThrow(
      /Source path must stay inside its configured source/u,
    );

    await fs.writeFile(
      path.join(workspace.sharedDir, "config", "tool.json"),
      '{"version":2}\n',
      "utf8",
    );
    const skipOutput = new PassThrough();
    await workflow.runTask(workspace, created, "skip-local", { output: skipOutput });
    expect(readOutput(skipOutput)).toMatch(/1\s+SKIPPED\s+copy[\s\S]*target exists/u);
    expect(await fs.readFile(path.join(created.path, ".local", "tool.json"), "utf8")).toBe(
      '{"version":1}\n',
    );
    const overwriteOutput = new PassThrough();
    await workflow.runTask(workspace, created, "sync-local", { output: overwriteOutput });
    expect(readOutput(overwriteOutput)).toMatch(
      /1\s+REPLACED\s+copy[\s\S]*target:\.local\/tool\.json[\s\S]*existing target/u,
    );
    expect(await fs.readFile(path.join(created.path, ".local", "tool.json"), "utf8")).toBe(
      '{"version":2}\n',
    );

    await fs.mkdir(path.join(created.path, ".local", "conflict"));
    await fs.writeFile(path.join(created.path, ".local", "conflict", "marker"), "keep\n");
    await expect(workflow.runTask(workspace, created, "directory-conflict")).rejects.toThrow(
      /Target target:\.local\/conflict already exists/u,
    );
    expect(await fs.readFile(path.join(created.path, ".local", "conflict", "marker"), "utf8")).toBe(
      "keep\n",
    );

    const outside = path.join(temporaryRoot, "outside-secret");
    await fs.writeFile(outside, "do not copy\n", "utf8");
    await fs.symlink(outside, path.join(workspace.sharedDir, "escape"));
    await expect(workflow.runTask(workspace, created, "escape")).rejects.toThrow(
      /Source path resolves outside/u,
    );

    const outsideShared = path.join(temporaryRoot, "outside-shared");
    await fs.mkdir(path.join(outsideShared, "config"), { recursive: true });
    await fs.writeFile(
      path.join(outsideShared, "config", "tool.json"),
      '{"outside":true}\n',
      "utf8",
    );
    await fs.rm(workspace.sharedDir, { recursive: true });
    await fs.symlink(outsideShared, workspace.sharedDir);
    await expect(workflow.runTask(workspace, created, "sync-local")).rejects.toThrow(
      /Shared path must be a directory, not a link/u,
    );
    await expect(workspaces.find(workspace.root)).rejects.toThrow(
      /Shared path must be a directory, not a link/u,
    );
  });

  it("expands file globs deterministically and preserves relative directory structure", async () => {
    await commitProjectConfig(
      repository,
      `version: 1
defaults:
  fetch: false
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env
      glob: "**/.env*"
      to: .
tasks:
  snapshot-env:
    steps:
      - type: copy
        source: shared
        from: env
        glob: "**/.env*"
        to: .snapshots
  optional-empty:
    steps:
      - type: copy
        source: shared
        from: env
        glob: "**/*.missing"
        to: optional
        optional: true
  required-empty:
    steps:
      - type: copy
        source: shared
        from: env
        glob: "**/*.missing"
        to: required
  preflight-conflict:
    steps:
      - type: copy
        source: shared
        from: fixtures
        glob: "**/*.json"
        to: generated
  skip-fixtures:
    steps:
      - type: copy
        source: shared
        from: fixtures
        glob: "**/*.json"
        to: generated
        on_existing: skip
  overwrite-fixtures:
    steps:
      - type: copy
        source: shared
        from: fixtures
        glob: "**/*.json"
        to: generated
        overwrite: true
  source-must-be-directory:
    steps:
      - type: copy
        source: shared
        from: fixtures/a.json
        glob: "**/*.json"
        to: invalid
  directories-only:
    steps:
      - type: copy
        source: shared
        from: directories
        glob: "**"
        to: directory-output
  glob-escape:
    steps:
      - type: copy
        source: shared
        from: unsafe
        glob: "**/*"
        to: unsafe-output
  target-traversal:
    steps:
      - type: copy
        source: shared
        from: fixtures
        glob: "**/*.json"
        to: ../outside-target
`,
    );
    const workspace = await workspaces.initialize(
      repository.remote,
      path.join(temporaryRoot, "glob-workspace"),
    );
    await fs.mkdir(path.join(workspace.sharedDir, "env", "apps", "api"), { recursive: true });
    await fs.mkdir(path.join(workspace.sharedDir, "env", "apps", "web"), { recursive: true });
    await fs.mkdir(path.join(workspace.sharedDir, "fixtures"), { recursive: true });
    await fs.mkdir(path.join(workspace.sharedDir, "directories", "nested"), { recursive: true });
    await fs.mkdir(path.join(workspace.sharedDir, "unsafe"), { recursive: true });
    await fs.writeFile(path.join(workspace.sharedDir, "env", ".env"), "ROOT=true\n", "utf8");
    await fs.writeFile(
      path.join(workspace.sharedDir, "env", "apps", "api", ".env"),
      "API=true\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace.sharedDir, "env", "apps", "web", ".env.local"),
      "WEB=true\n",
      "utf8",
    );
    await fs.writeFile(path.join(workspace.sharedDir, "fixtures", "a.json"), '{"a":1}\n');
    await fs.writeFile(path.join(workspace.sharedDir, "fixtures", "b.json"), '{"b":1}\n');

    const workflow = createWorkflow(git, worktrees, configs);
    const plan = await workflow.planCreate(workspace, { branch: "main", fetch: false });
    if (!plan.project) throw new Error("Expected project configuration.");
    await configs.trust(workspace, plan.project);
    const createOutput = new PassThrough();
    const created = await workflow.executeCreate(plan, { output: createOutput });

    const renderedCreate = readOutput(createOutput);
    expect(renderedCreate).toContain("Hook        post_create");
    expect(renderedCreate).toMatch(/1\s+RUNNING\s+symlink\s+shared:env\/\*\*\/\.env\*/u);
    expect(renderedCreate).toMatch(/1\s+CREATED\s+symlink\s+shared:env\/\.env\s+target:\.env/u);
    expect(renderedCreate).toMatch(
      /1\s+CREATED\s+symlink\s+shared:env\/apps\/api\/\.env\s+target:apps\/api\/\.env/u,
    );
    expect(renderedCreate).toMatch(
      /1\s+CREATED\s+symlink\s+shared:env\/apps\/web\/\.env\.local\s+target:apps\/web\/\.env\.local/u,
    );

    for (const file of [".env", "apps/api/.env", "apps/web/.env.local"]) {
      const target = path.join(created.path, file);
      expect(path.isAbsolute(await fs.readlink(target))).toBe(false);
    }
    expect(await fs.readFile(path.join(created.path, "apps", "api", ".env"), "utf8")).toBe(
      "API=true\n",
    );

    const rerunOutput = new PassThrough();
    await workflow.runHook(workspace, created, "post_create", { output: rerunOutput });
    expect(readOutput(rerunOutput).match(/UNCHANGED\s+symlink/gu)).toHaveLength(3);

    await workflow.runTask(workspace, created, "snapshot-env");
    expect(
      await fs.readFile(path.join(created.path, ".snapshots", "apps", "web", ".env.local"), "utf8"),
    ).toBe("WEB=true\n");
    const optionalOutput = new PassThrough();
    await workflow.runTask(workspace, created, "optional-empty", { output: optionalOutput });
    expect(readOutput(optionalOutput)).toMatch(
      /1\s+SKIPPED\s+copy\s+shared:env\/\*\*\/\*\.missing\s+target:optional\s+no files matched/u,
    );
    await expect(fs.stat(path.join(created.path, "optional"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(workflow.runTask(workspace, created, "required-empty")).rejects.toThrow(
      /Glob did not match any files/u,
    );

    await fs.mkdir(path.join(created.path, "generated"), { recursive: true });
    await fs.writeFile(path.join(created.path, "generated", "b.json"), "existing\n");
    const conflictOutput = new PassThrough();
    await expect(
      workflow.runTask(workspace, created, "preflight-conflict", { output: conflictOutput }),
    ).rejects.toThrow(
      /Automation step 1 \(copy target:generated\/b\.json\) failed[\s\S]*on_existing/u,
    );
    expect(readOutput(conflictOutput)).toMatch(
      /1\s+FAILED\s+copy[\s\S]*target:generated\/b\.json[\s\S]*on_existing/u,
    );
    await expect(fs.stat(path.join(created.path, "generated", "a.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const skipOutput = new PassThrough();
    await workflow.runTask(workspace, created, "skip-fixtures", { output: skipOutput });
    const renderedSkip = readOutput(skipOutput);
    expect(renderedSkip).toMatch(/1\s+CREATED\s+copy[\s\S]*target:generated\/a\.json/u);
    expect(renderedSkip).toMatch(
      /1\s+SKIPPED\s+copy[\s\S]*target:generated\/b\.json[\s\S]*target exists/u,
    );

    const overwriteOutput = new PassThrough();
    await workflow.runTask(workspace, created, "overwrite-fixtures", { output: overwriteOutput });
    expect(readOutput(overwriteOutput).match(/REPLACED\s+copy/gu)).toHaveLength(2);
    expect(await fs.readFile(path.join(created.path, "generated", "a.json"), "utf8")).toBe(
      '{"a":1}\n',
    );
    expect(await fs.readFile(path.join(created.path, "generated", "b.json"), "utf8")).toBe(
      '{"b":1}\n',
    );
    await expect(workflow.runTask(workspace, created, "source-must-be-directory")).rejects.toThrow(
      /Glob source must be a directory/u,
    );
    await expect(workflow.runTask(workspace, created, "directories-only")).rejects.toThrow(
      /Glob did not match any files/u,
    );
    await expect(workflow.runTask(workspace, created, "target-traversal")).rejects.toThrow(
      /Target path must stay inside/u,
    );

    const outside = path.join(temporaryRoot, "outside-glob-secret.json");
    await fs.writeFile(outside, '{"secret":true}\n');
    await fs.symlink(outside, path.join(workspace.sharedDir, "unsafe", "secret.json"));
    await expect(workflow.runTask(workspace, created, "glob-escape")).rejects.toThrow(
      /Glob match resolves outside/u,
    );
  });
});

async function commitProjectConfig(
  repository: TestRepository,
  configuration: string,
  files: Record<string, string> = {},
): Promise<void> {
  await fs.writeFile(path.join(repository.source, ".ygg.yml"), configuration, "utf8");
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(repository.source, name), content, "utf8");
  }
  await gitRun(repository.source, ["add", ".ygg.yml", ...Object.keys(files)]);
  await gitRun(repository.source, ["commit", "-m", "add ygg workflow"]);
  await gitRun(repository.source, ["push", "origin", "main"]);
}

async function gitRun(cwd: string, args: string[]): Promise<void> {
  await new GitClient().run(args, { cwd });
}

function readOutput(output: PassThrough): string {
  return output.read()?.toString() ?? "";
}

function createWorkflow(
  git: GitClient,
  worktrees: WorktreeService,
  configs: ConfigService,
): WorktreeWorkflowService {
  const automation = new AutomationService(
    new ProcessRunner(),
    (output, presentation) => new AutomationReporter(output, presentation),
  );
  return new WorktreeWorkflowService(git, worktrees, configs, automation);
}
