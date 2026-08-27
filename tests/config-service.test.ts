import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../src/domain/types.js";
import {
  ConfigService,
  projectConfigFileName,
  summarizeExecutableConfig,
  workspaceConfigFileName,
  workspaceProjectConfigFileName,
} from "../src/services/config-service.js";

describe("project YAML configuration", () => {
  const configs = new ConfigService();

  it("rejects repository project configuration symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-config-link-test-"));
    try {
      const target = path.join(root, "outside.yml");
      await fs.writeFile(target, "version: 1\n", "utf8");
      await fs.symlink(target, path.join(root, projectConfigFileName));

      await expect(configs.readProjectConfig(root)).rejects.toThrow(/must be a regular file/u);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("uses the clean-break .yml filenames", () => {
    expect(projectConfigFileName).toBe(".ygg.yml");
    expect(workspaceConfigFileName).toBe("workspace.yml");
    expect(workspaceProjectConfigFileName).toBe("project.yml");
  });

  it("uses a semantic hash so comments and key order do not invalidate trust", () => {
    const first = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: command
      argv: [pnpm, install]
tasks:
  check:
    steps:
      - type: command
        argv: [pnpm, test]
`,
      ".ygg.yml",
    );
    const reformatted = configs.parseProjectConfig(
      `# formatting is not behavior
tasks:
  check:
    steps:
      - argv:
          - pnpm
          - test
        type: command
hooks:
  post_create:
    - argv: [pnpm, install]
      type: command
version: 1
`,
      ".ygg.yml",
    );
    const changed = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: command
      argv: [pnpm, install, --frozen-lockfile]
tasks:
  check:
    steps:
      - type: command
        argv: [pnpm, test]
`,
      ".ygg.yml",
    );

    expect(first.requiresTrust).toBe(true);
    expect(reformatted.hash).toBe(first.hash);
    expect(changed.hash).not.toBe(first.hash);
  });

  it("supports explicit target policies without invalidating equivalent legacy trust", () => {
    const legacyError = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env
      overwrite: false
`,
      ".ygg.yml",
    );
    const explicitError = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env
      on_existing: error
`,
      ".ygg.yml",
    );
    const legacyReplace = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env
      overwrite: true
`,
      ".ygg.yml",
    );
    const explicitReplace = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env
      on_existing: replace
`,
      ".ygg.yml",
    );
    const skip = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env
      on_existing: skip
`,
      ".ygg.yml",
    );

    expect(explicitError.config.hooks.post_create[0]).toMatchObject({ onExisting: "error" });
    expect(explicitReplace.config.hooks.post_create[0]).toMatchObject({ onExisting: "replace" });
    expect(skip.config.hooks.post_create[0]).toMatchObject({ onExisting: "skip" });
    expect(explicitError.hash).toBe(legacyError.hash);
    expect(explicitError.hash).toBe(
      "5e1acb26c770d14432090f8493125651da944e4519a4fef926b0e5722f7d6b73",
    );
    expect(explicitReplace.hash).toBe(legacyReplace.hash);
    expect(explicitReplace.hash).toBe(
      "233805b3051a791b72e1d01a1f6668285f487a1bb8523dd0386408f0c852eeb5",
    );
    expect(skip.hash).not.toBe(explicitError.hash);
    expect(skip.hash).not.toBe(explicitReplace.hash);
    expect(configs.formatProjectConfig(skip.config)).toContain("on_existing: skip");
    expect(summarizeExecutableConfig(skip)).toContain(
      "hook post_create: symlink shared:env/.env -> .env [on_existing=skip]",
    );
  });

  it("rejects ambiguous new and legacy target policies", () => {
    expect(() =>
      configs.parseProjectConfig(
        `version: 1
hooks:
  post_create:
    - type: copy
      from: config.example
      to: config.local
      on_existing: skip
      overwrite: true
`,
        ".ygg.yml",
      ),
    ).toThrow(/cannot define both 'on_existing' and legacy 'overwrite'/u);
  });

  it("rejects unknown fields and ambiguous command execution", () => {
    expect(() =>
      configs.parseProjectConfig(
        `version: 1
hooks:
  post_create:
    - type: command
      argv: [pnpm, install]
      shell: pnpm install
      surprise: true
`,
        ".ygg.yml",
      ),
    ).toThrow(/Configuration is invalid/u);
  });

  it("does not require trust for declarative defaults alone", () => {
    const document = configs.parseProjectConfig(
      `version: 1
defaults:
  fetch: false
`,
      ".ygg.yml",
    );

    expect(document.requiresTrust).toBe(false);
    expect(document.config.defaults).toEqual({ fetch: false });
  });

  it("allows empty command arguments but requires a non-empty executable", () => {
    const document = configs.parseProjectConfig(
      `version: 1
tasks:
  empty-argument:
    steps:
      - type: command
        argv: [printf, ""]
`,
      ".ygg.yml",
    );

    expect(document.config.tasks["empty-argument"]?.steps[0]).toMatchObject({
      argv: ["printf", ""],
    });
    expect(() =>
      configs.parseProjectConfig(
        `version: 1
tools:
  broken:
    command: [""]
`,
        ".ygg.yml",
      ),
    ).toThrow(/first argv entry must name an executable/u);
  });

  it("accepts shared as a declarative file source", () => {
    const document = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env
`,
      ".ygg.yml",
    );

    expect(document.config.hooks.post_create[0]).toMatchObject({
      type: "symlink",
      source: "shared",
      from: "env/.env",
      to: ".env",
    });
    expect(document.requiresTrust).toBe(true);
    expect(summarizeExecutableConfig(document)).toContain(
      "hook post_create: symlink shared:env/.env -> .env",
    );
  });

  it("parses glob file steps and includes the pattern in trust behavior", () => {
    const first = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env
      glob: "**/.env*"
      to: .
`,
      ".ygg.yml",
    );
    const changed = configs.parseProjectConfig(
      `version: 1
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env
      glob: "**/*.json"
      to: .
`,
      ".ygg.yml",
    );

    expect(first.config.hooks.post_create[0]).toMatchObject({
      type: "symlink",
      from: "env",
      glob: "**/.env*",
      to: ".",
    });
    expect(first.hash).not.toBe(changed.hash);
    expect(configs.formatProjectConfig(first.config)).toContain('glob: "**/.env*"');
    expect(summarizeExecutableConfig(first)).toContain(
      "hook post_create: symlink shared:env/**/.env* -> .",
    );
  });

  it.each(["../*.env", "/tmp/*.env", "!secret.env", "C:\\\\secrets\\\\*.env"])(
    "rejects unsafe glob pattern %s",
    (glob) => {
      expect(() =>
        configs.parseProjectConfig(
          `version: 1
hooks:
  post_create:
    - type: copy
      from: env
      glob: ${JSON.stringify(glob)}
      to: .
`,
          ".ygg.yml",
        ),
      ).toThrow(/positive relative pattern/u);
    },
  );
});

describe("effective project configuration", () => {
  const configs = new ConfigService();
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ygg-config-merge-test-")));
    await fs.mkdir(path.join(root, ".ygg"));
    workspace = createWorkspace(root);
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  it("merges local defaults and named sections while replacing configured hooks", async () => {
    await fs.writeFile(
      path.join(root, ".ygg.yml"),
      `version: 1
defaults:
  fetch: false
  tool: code
hooks:
  post_create:
    - type: command
      argv: [node, base.js]
  pre_remove:
    - type: command
      argv: [node, preserve.js]
tasks:
  inherited:
    steps:
      - type: command
        argv: [node, inherited.js]
  removed:
    steps:
      - type: command
        argv: [node, removed.js]
tools:
  removed:
    command: [code, .]
`,
      "utf8",
    );
    await configs.writeWorkspaceProjectConfig(workspace, {
      version: 1,
      defaults: { tool: null },
      hooks: { post_create: [] },
      tasks: {
        removed: null,
        local: {
          description: "Local task",
          steps: [
            {
              type: "command",
              argv: ["node", "local.js"],
              env: {},
              continueOnError: false,
            },
          ],
        },
      },
      tools: { removed: null },
    });

    const effective = await configs.resolveProjectConfig(workspace, root);

    expect(effective?.config.defaults).toEqual({ fetch: false });
    expect(effective?.config.hooks.post_create).toEqual([]);
    expect(effective?.config.hooks.pre_remove).toHaveLength(1);
    expect(Object.keys(effective?.config.tasks ?? {})).toEqual(["inherited", "local"]);
    expect(effective?.config.tools).toEqual({});
    expect(effective?.sources).toEqual({
      repository: path.join(root, ".ygg.yml"),
      workspace: path.join(root, ".ygg", "project.yml"),
    });
    expect((await fs.stat(path.join(root, ".ygg", "project.yml"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the effective trust hash stable when a repository config is copied locally", async () => {
    const config = configs.parseProjectConfig(
      `version: 1
tasks:
  verify:
    steps:
      - type: command
        argv: [pnpm, test]
`,
      path.join(root, ".ygg.yml"),
    ).config;
    await configs.writeProjectConfig(root, config);
    const repositoryOnly = await configs.resolveProjectConfig(workspace, root);

    await configs.writeWorkspaceProjectConfig(workspace, config);
    await fs.rm(path.join(root, ".ygg.yml"));
    const workspaceOnly = await configs.resolveProjectConfig(workspace, root);

    expect(workspaceOnly?.hash).toBe(repositoryOnly?.hash);
    expect(workspaceOnly?.sources).toEqual({
      repository: null,
      workspace: path.join(root, ".ygg", "project.yml"),
    });
  });

  it("rejects a workspace project configuration symlink", async () => {
    const outside = path.join(root, "outside.yml");
    await fs.writeFile(outside, "version: 1\n", "utf8");
    await fs.symlink(outside, path.join(root, ".ygg", "project.yml"));

    await expect(configs.resolveProjectConfig(workspace, root)).rejects.toThrow(
      /must be a regular file/u,
    );
  });

  it("rejects unknown fields in workspace-local project configuration", async () => {
    await fs.writeFile(
      path.join(root, ".ygg", "project.yml"),
      "version: 1\nunknown_behavior: true\n",
      "utf8",
    );

    await expect(configs.resolveProjectConfig(workspace, root)).rejects.toThrow(
      /Configuration is invalid:[\s\S]*Unrecognized key/u,
    );
  });
});

function createWorkspace(root: string): Workspace {
  return {
    root,
    configPath: path.join(root, ".ygg", "workspace.yml"),
    sharedDir: path.join(root, ".ygg", "shared"),
    gitDir: path.join(root, "repo.git"),
    worktreeDir: root,
    primaryWorktree: null,
    config: {
      version: 1,
      mode: "managed",
      paths: { git: "../repo.git", worktrees: "..", primaryWorktree: null },
      remote: null,
      defaultBranch: "main",
      trustedProjectConfig: null,
    },
  };
}
