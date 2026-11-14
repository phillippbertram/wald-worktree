import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../src/cli/context.js";
import { initializeProjectConfiguration } from "../src/cli/project-config-wizard.js";
import type { Workspace } from "../src/domain/types.js";
import { ConfigService } from "../src/services/config-service.js";
import { ProjectConfigInitializer } from "../src/services/project-config-initializer.js";

const prompts = vi.hoisted(() => ({
  confirmations: [] as boolean[],
  selections: [] as string[],
  manySelections: [] as string[][],
}));

vi.mock("../src/ui/terminal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/terminal.js")>();
  return {
    ...actual,
    isInteractiveTerminal: () => true,
    runTask: async <T>(_label: string, task: () => Promise<T>) => await task(),
    confirm: async (_question: string, defaultValue = false) =>
      prompts.confirmations.shift() ?? defaultValue,
    selectManyValues: async () => prompts.manySelections.shift() ?? [],
    selectValue: async () => prompts.selections.shift() ?? "__none__",
    printKeyValueTable: async () => undefined,
    printStatus: async () => undefined,
  };
});

describe("interactive project configuration wizard", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    prompts.confirmations = [];
    prompts.selections = [];
    prompts.manySelections = [];
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wald-config-wizard-test-")));
    await fs.mkdir(path.join(root, ".wald"));
    workspace = createWorkspace(root);
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { build: "tsc", dev: "vite", lint: "biome check .", test: "vitest" },
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  it("allows an empty verify script selection after accepting the task", async () => {
    prompts.selections.push("customize", "__none__", "write");
    prompts.confirmations.push(true, false, false, true, true);
    prompts.manySelections.push([]);

    const document = await initializeProjectConfiguration(
      workspace,
      root,
      { force: false, yes: false, scope: "workspace", fromProject: false },
      createContext(),
    );

    expect(document?.config.tasks).toEqual({});
  });

  it("keeps detected verify defaults for non-interactive initialization", async () => {
    const document = await initializeProjectConfiguration(
      workspace,
      root,
      { force: false, yes: true, scope: "workspace", fromProject: false },
      createContext(),
    );

    expect(document?.config.tasks.verify?.steps).toEqual([
      expect.objectContaining({ argv: ["pnpm", "run", "lint"] }),
      expect.objectContaining({ argv: ["pnpm", "run", "test"] }),
    ]);
    expect(document?.config.tasks.dev?.steps).toEqual([
      expect.objectContaining({ argv: ["pnpm", "run", "dev"] }),
    ]);
  });

  it("accepts detected settings in one review without granting trust", async () => {
    prompts.selections.push("write");
    const document = await initializeProjectConfiguration(
      workspace,
      root,
      { force: false, yes: false, scope: "workspace", fromProject: false },
      createContext(),
    );
    expect(document?.config.hooks.post_create).toHaveLength(1);
    expect(document?.config.tasks.verify?.steps).toHaveLength(2);
    expect(workspace.config.trustedProjectConfig).toBeNull();
  });

  it("allows inspecting the full configuration and cancelling without writing", async () => {
    prompts.selections.push("show", "cancel");
    const context = createContext();
    const output = new PassThrough();
    context.output.stdout = output;
    const result = await initializeProjectConfiguration(
      workspace,
      root,
      { force: false, yes: false, scope: "workspace", fromProject: false },
      context,
    );
    expect(result).toBeNull();
    expect(output.read()?.toString()).toContain("post_create:");
    await expect(fs.access(path.join(root, ".wald", "project.yml"))).rejects.toThrow();
  });

  it("keeps an existing configuration when the replacement review is cancelled", async () => {
    const target = path.join(root, ".wald", "project.yml");
    const original = "version: 1\ndefaults:\n  fetch: false\n";
    await fs.writeFile(target, original);
    prompts.confirmations.push(true);
    prompts.selections.push("cancel");
    await initializeProjectConfiguration(
      workspace,
      root,
      { force: false, yes: false, scope: "workspace", fromProject: false },
      createContext(),
    );
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });
});

function createContext(): CliContext {
  const output = new PassThrough();
  return {
    output: { stdout: output, stderr: output },
    configs: new ConfigService(),
    projectConfigs: new ProjectConfigInitializer(),
  } as unknown as CliContext;
}

function createWorkspace(root: string): Workspace {
  return {
    root,
    configPath: path.join(root, ".wald", "workspace.yml"),
    sharedDir: path.join(root, ".wald", "shared"),
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
