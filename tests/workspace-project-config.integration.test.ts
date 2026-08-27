import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepository, type TestRepository } from "./helpers/git-repository.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "src", "cli.ts");
const tsxLoader = import.meta.resolve("tsx");

function cliArguments(...args: string[]): string[] {
  return ["--import", tsxLoader, cli, ...args];
}

async function runCli(cwd: string, ...args: string[]) {
  return await execa(process.execPath, cliArguments(...args), { cwd, reject: false });
}

describe("workspace-local project configuration", { timeout: 15_000 }, () => {
  let temporaryRoot: string;
  let repository: TestRepository;
  let workspace: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-local-config-test-"));
    repository = await createTestRepository(temporaryRoot);
    workspace = path.join(temporaryRoot, "workspace");
    const initialized = await runCli(temporaryRoot, "init", repository.remote, workspace);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    workspace = await fs.realpath(workspace);
    const created = await runCli(workspace, "create", "main", "--no-fetch");
    expect(created.exitCode, created.stderr).toBe(0);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("writes repository configuration only when project scope is explicit", async () => {
    const configured = await runCli(
      workspace,
      "config",
      "init",
      "main",
      "--scope",
      "project",
      "--yes",
    );

    expect(configured.exitCode, configured.stderr).toBe(0);
    expect(configured.stdout).toContain("review and commit .ygg.yml");
    await expect(fs.readFile(path.join(workspace, "main", ".ygg.yml"), "utf8")).resolves.toContain(
      "version: 1",
    );
    await expect(fs.stat(path.join(workspace, ".ygg", "project.yml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("copies repository behavior locally without deleting it or changing its trust hash", async () => {
    const repositoryConfigPath = path.join(workspace, "main", ".ygg.yml");
    const localConfigPath = path.join(workspace, ".ygg", "project.yml");
    await fs.writeFile(
      repositoryConfigPath,
      `version: 1
tasks:
  verify:
    description: Verify locally
    steps:
      - type: command
        argv: [node, --version]
`,
      "utf8",
    );

    const repositoryOnly = await runCli(workspace, "config");
    expect(repositoryOnly.exitCode, repositoryOnly.stderr).toBe(0);
    const hash = readField(repositoryOnly.stdout, "effective_project_hash");
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);

    const migrated = await runCli(
      workspace,
      "config",
      "init",
      "main",
      "--scope",
      "workspace",
      "--from-project",
      "--yes",
    );
    expect(migrated.exitCode, migrated.stderr).toBe(0);
    expect(migrated.stdout).toContain(".ygg.yml was kept");
    await expect(fs.readFile(repositoryConfigPath, "utf8")).resolves.toContain("Verify locally");
    await expect(fs.readFile(localConfigPath, "utf8")).resolves.toContain("Verify locally");
    expect((await fs.stat(localConfigPath)).mode & 0o777).toBe(0o600);

    const both = await runCli(workspace, "config");
    expect(readField(both.stdout, "repository_project_config")).toBe(repositoryConfigPath);
    expect(readField(both.stdout, "workspace_project_config")).toBe(localConfigPath);
    expect(readField(both.stdout, "effective_project_hash")).toBe(hash);

    const trusted = await runCli(workspace, "config", "trust", "--yes");
    expect(trusted.exitCode, trusted.stderr).toBe(0);
    await fs.rm(repositoryConfigPath);

    const localOnly = await runCli(workspace, "config");
    expect(readField(localOnly.stdout, "repository_project_config")).toBe("none");
    expect(readField(localOnly.stdout, "workspace_project_config")).toBe(localConfigPath);
    expect(readField(localOnly.stdout, "effective_project_hash")).toBe(hash);
    expect(readField(localOnly.stdout, "trusted")).toBe("true");
  });

  it("keeps unmentioned repository behavior when generating local detected settings", async () => {
    await fs.writeFile(
      path.join(workspace, "main", ".ygg.yml"),
      `version: 1
tasks:
  inherited:
    steps:
      - type: command
        argv: [node, --version]
`,
      "utf8",
    );

    const configured = await runCli(workspace, "config", "init", "main", "--yes");
    expect(configured.exitCode, configured.stderr).toBe(0);
    const localContent = await fs.readFile(path.join(workspace, ".ygg", "project.yml"), "utf8");
    expect(localContent).not.toContain("hooks:");
    expect(localContent).not.toContain("tasks:");

    const trusted = await runCli(workspace, "config", "trust", "--yes");
    expect(trusted.exitCode, trusted.stderr).toBe(0);
    const inherited = await runCli(workspace, "run", "inherited", "main");
    expect(inherited.exitCode, inherited.stderr).toBe(0);
    expect(inherited.stdout).toContain("Completed task inherited");
  });

  it("lets explicit init scope retain repository-owned behavior", async () => {
    const adoptedWorktrees = path.join(temporaryRoot, "adopted-worktrees");
    const adopted = await runCli(
      temporaryRoot,
      "init",
      "--adopt",
      repository.source,
      "--worktrees-dir",
      adoptedWorktrees,
      "--yes",
      "--config",
      "--config-scope",
      "project",
    );

    expect(adopted.exitCode, adopted.stderr).toBe(0);
    await expect(fs.readFile(path.join(repository.source, ".ygg.yml"), "utf8")).resolves.toContain(
      "version: 1",
    );
    await expect(
      fs.stat(path.join(repository.source, ".git", "ygg", "project.yml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("protects workspace-local project configuration during uninitialization", async () => {
    const configured = await runCli(workspace, "config", "init", "main", "--yes");
    expect(configured.exitCode, configured.stderr).toBe(0);
    const removed = await runCli(workspace, "remove", "main", "--yes");
    expect(removed.exitCode, removed.stderr).toBe(0);

    const uninitialized = await runCli(workspace, "uninit", "--apply", "--yes");

    expect(uninitialized.exitCode).toBe(1);
    expect(uninitialized.stdout).toContain("project.yml");
    expect(uninitialized.stderr).toContain("Use --force only if this data can be discarded");
    await expect(
      fs.readFile(path.join(workspace, ".ygg", "project.yml"), "utf8"),
    ).resolves.toContain("version: 1");
  });

  it("manually runs every hook from the latest effective local configuration", async () => {
    const worktree = await fs.realpath(path.join(workspace, "main"));
    const localConfig = path.join(workspace, ".ygg", "project.yml");
    const logPath = path.join(workspace, "manual-hooks.log");
    await fs.writeFile(localConfig, manualHookConfig("process.env.YGG_EVENT"), "utf8");

    const trusted = await runCli(worktree, "config", "trust", "--yes");
    expect(trusted.exitCode, trusted.stderr).toBe(0);

    const results = new Map<string, Awaited<ReturnType<typeof runCli>>>();
    for (const event of ["pre_create", "post_create", "pre_remove", "post_remove"]) {
      results.set(event, await runCli(workspace, "hook", "run", event, "main"));
    }

    for (const [event, result] of results) {
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Completed ${event} hook for main`);
    }
    expect(results.get("pre_create")?.stderr).toContain(
      "Manual pre_create runs against existing worktree main",
    );
    expect(results.get("post_remove")?.stderr).toContain(
      "Manual post_remove keeps existing worktree main",
    );
    expect((await fs.readFile(logPath, "utf8")).trim().split("\n")).toEqual([
      `pre_create|${worktree}|${worktree}`,
      `post_create|${worktree}|${worktree}`,
      `pre_remove|${worktree}|${worktree}`,
      `post_remove|${workspace}|${worktree}`,
    ]);
    const listed = await runCli(workspace, "list", "--json");
    expect(JSON.parse(listed.stdout)).toHaveLength(1);
    await expect(fs.stat(worktree)).resolves.toSatisfy((stat) => stat.isDirectory());

    await fs.writeFile(
      localConfig,
      manualHookConfig(`"changed:" + process.env.YGG_EVENT`, ["post_create"]),
      "utf8",
    );
    const untrusted = await runCli(workspace, "hook", "run", "post_create", "main");
    expect(untrusted.exitCode).toBe(1);
    expect(untrusted.stderr).toContain("not trusted");

    const missing = await runCli(workspace, "hook", "run", "pre_remove", "main");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("No pre_remove hook is configured for main");

    const retrusted = await runCli(worktree, "config", "trust", "--yes");
    expect(retrusted.exitCode, retrusted.stderr).toBe(0);
    const rerun = await runCli(workspace, "hook", "run", "post_create", "main");
    expect(rerun.exitCode, rerun.stderr).toBe(0);
    const setup = await runCli(workspace, "setup", "main");
    expect(setup.exitCode, setup.stderr).toBe(0);
    expect(setup.stdout).toContain("Completed setup for main");
    expect((await fs.readFile(logPath, "utf8")).trim().split("\n").slice(-2)).toEqual([
      `changed:post_create|${worktree}|${worktree}`,
      `changed:post_create|${worktree}|${worktree}`,
    ]);

    const unknown = await runCli(workspace, "hook", "run", "unknown", "main");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain(
      "Allowed choices are pre_create, post_create, pre_remove, post_remove",
    );
  });
});

function readField(output: string, field: string): string {
  const line = output.split("\n").find((candidate) => candidate.startsWith(`${field}: `));
  if (!line) throw new Error(`Missing ${field} in output:\n${output}`);
  return line.slice(field.length + 2);
}

function manualHookConfig(
  eventExpression: string,
  events = ["pre_create", "post_create", "pre_remove", "post_remove"],
): string {
  const script = `require('node:fs').appendFileSync(process.env.YGG_WORKSPACE_ROOT + '/manual-hooks.log', [${eventExpression}, process.cwd(), process.env.YGG_WORKTREE_PATH].join('|') + String.fromCharCode(10))`;
  const step = `    - type: command\n      argv: [node, -e, ${JSON.stringify(script)}]`;
  return `version: 1
hooks:
${events.map((event) => `  ${event}:\n${step}`).join("\n")}
`;
}
