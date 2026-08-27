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
import { PromptBackError } from "../src/ui/terminal.js";

const prompts = vi.hoisted(() => ({
  confirmations: [] as Array<boolean | Error>,
  confirmationCalls: [] as Array<{ question: string; defaultValue: boolean }>,
  selections: [] as string[],
  manySelections: [] as string[][],
  manyCalls: [] as Array<{
    question: string;
    options: Array<{ label: string; checked?: boolean }>;
  }>,
}));

vi.mock("../src/ui/terminal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/terminal.js")>();
  return {
    ...actual,
    isInteractiveTerminal: () => true,
    runTask: async <T>(_label: string, task: () => Promise<T>) => await task(),
    confirm: async (question: string, defaultValue = false) => {
      prompts.confirmationCalls.push({ question, defaultValue });
      const confirmation = prompts.confirmations.shift() ?? defaultValue;
      if (confirmation instanceof Error) throw confirmation;
      return confirmation;
    },
    selectManyValues: async (
      question: string,
      options: Array<{ label: string; checked?: boolean }>,
    ) => {
      prompts.manyCalls.push({
        question,
        options: options.map(({ label, checked }) => ({ label, checked })),
      });
      return prompts.manySelections.shift() ?? [];
    },
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
    prompts.confirmationCalls = [];
    prompts.selections = [];
    prompts.manySelections = [];
    prompts.manyCalls = [];
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ygg-config-wizard-test-")));
    await fs.mkdir(path.join(root, ".ygg"));
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

  it("skips the verify script selection when the task is declined", async () => {
    prompts.confirmations.push(true, false, false, false, true);

    const document = await initializeProjectConfiguration(
      workspace,
      root,
      { force: false, yes: false, scope: "workspace", fromProject: false },
      createContext(),
    );

    expect(prompts.confirmationCalls).toContainEqual({
      question: "Configure › Tasks · Create a 'verify' task from detected package scripts?",
      defaultValue: true,
    });
    expect(prompts.manyCalls).toEqual([]);
    expect(document?.config.tasks).toEqual({});
  });

  it("allows an empty verify script selection after accepting the task", async () => {
    prompts.confirmations.push(true, false, false, true, true);
    prompts.manySelections.push([]);

    const document = await initializeProjectConfiguration(
      workspace,
      root,
      { force: false, yes: false, scope: "workspace", fromProject: false },
      createContext(),
    );

    expect(prompts.manyCalls).toEqual([
      {
        question: "Configure › Tasks · Select package scripts for the verify task:",
        options: [
          { label: "build", checked: false },
          { label: "lint", checked: true },
          { label: "test", checked: true },
        ],
      },
    ]);
    expect(document?.config.tasks).toEqual({});
  });

  it("keeps detected verify defaults for non-interactive initialization", async () => {
    const document = await initializeProjectConfiguration(
      workspace,
      root,
      { force: false, yes: true, scope: "workspace", fromProject: false },
      createContext(),
    );

    expect(prompts.confirmationCalls).toEqual([]);
    expect(prompts.manyCalls).toEqual([]);
    expect(document?.config.tasks.verify?.steps).toEqual([
      expect.objectContaining({ argv: ["pnpm", "run", "lint"] }),
      expect.objectContaining({ argv: ["pnpm", "run", "test"] }),
    ]);
    expect(document?.config.tasks.dev?.steps).toEqual([
      expect.objectContaining({ argv: ["pnpm", "run", "dev"] }),
    ]);
  });

  it("returns one step and reuses the previous answer as the default", async () => {
    prompts.confirmations.push(false, new PromptBackError(), false, true, false, false, true);
    prompts.selections.push("__none__");

    await initializeProjectConfiguration(
      workspace,
      root,
      { force: false, yes: false, scope: "workspace", fromProject: false },
      createContext(),
    );

    const fetchCalls = prompts.confirmationCalls.filter((call) =>
      call.question.includes("Fetch before resolving branches"),
    );
    expect(fetchCalls).toEqual([
      expect.objectContaining({ defaultValue: true }),
      expect.objectContaining({ defaultValue: false }),
    ]);
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
