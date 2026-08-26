import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WtError } from "../domain/errors.js";
import type { AutomationStep, ProjectConfig } from "../domain/types.js";

const packageJsonSchema = z
  .object({
    scripts: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export type ProjectSetupInspection = {
  root: string;
  packageManager: PackageManager | null;
  installCommand: string[] | null;
  scripts: string[];
  recommendedScripts: string[];
  environmentExample: string | null;
};

export type ProjectConfigTemplateOptions = {
  fetch: boolean;
  install: boolean;
  copyEnvironment: boolean;
  scripts: string[];
  tool?: string;
};

export class ProjectConfigInitializer {
  async inspect(root: string): Promise<ProjectSetupInspection> {
    const canonicalRoot = await fs.realpath(root);
    const packageManager = await detectPackageManager(canonicalRoot);
    const scripts = await readPackageScripts(canonicalRoot);
    return {
      root: canonicalRoot,
      packageManager,
      installCommand: packageManager
        ? await installCommandFor(packageManager, canonicalRoot)
        : null,
      scripts,
      recommendedScripts: recommendedScripts(scripts),
      environmentExample: await detectEnvironmentExample(canonicalRoot),
    };
  }

  createConfig(
    inspection: ProjectSetupInspection,
    options: ProjectConfigTemplateOptions,
  ): ProjectConfig {
    const postCreate: AutomationStep[] = [];
    if (options.install && inspection.installCommand) {
      postCreate.push({
        type: "command",
        argv: inspection.installCommand,
        cwd: "target",
        env: {},
        continueOnError: false,
      });
    }
    if (options.copyEnvironment && inspection.environmentExample) {
      postCreate.push({
        type: "copy",
        source: "default",
        from: inspection.environmentExample,
        to: ".env",
        optional: true,
        overwrite: false,
        continueOnError: false,
      });
    }

    const selectedScripts = options.scripts.filter((script) => inspection.scripts.includes(script));
    const taskRunner = inspection.packageManager ?? "npm";
    return {
      version: 1,
      defaults: {
        fetch: options.fetch,
        tool: options.tool,
      },
      hooks: {
        pre_create: [],
        post_create: postCreate,
        pre_remove: [],
        post_remove: [],
      },
      tasks:
        selectedScripts.length > 0
          ? {
              verify: {
                description: "Run the detected project checks",
                steps: selectedScripts.map((script) => ({
                  type: "command" as const,
                  argv: [taskRunner, "run", script],
                  cwd: "target" as const,
                  env: {},
                  continueOnError: false,
                })),
              },
            }
          : {},
      tools: {},
    };
  }
}

async function detectPackageManager(root: string): Promise<PackageManager | null> {
  for (const candidate of [
    { files: ["pnpm-lock.yaml"], manager: "pnpm" },
    { files: ["yarn.lock"], manager: "yarn" },
    { files: ["package-lock.json", "npm-shrinkwrap.json"], manager: "npm" },
    { files: ["bun.lock", "bun.lockb"], manager: "bun" },
  ] as const) {
    if (await anyFileExists(root, candidate.files)) {
      return candidate.manager;
    }
  }
  return (await fileExists(path.join(root, "package.json"))) ? "npm" : null;
}

async function readPackageScripts(root: string): Promise<string[]> {
  const packagePath = path.join(root, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(packagePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw new WtError(`Cannot read package metadata: ${packagePath}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new WtError(`Package metadata is not valid JSON: ${packagePath}`, { cause: error });
  }
  const parsed = packageJsonSchema.safeParse(value);
  if (!parsed.success) {
    throw new WtError(`Package scripts are invalid: ${packagePath}\n${parsed.error.message}`);
  }
  return Object.keys(parsed.data.scripts).sort((left, right) => left.localeCompare(right));
}

async function detectEnvironmentExample(root: string): Promise<string | null> {
  for (const candidate of [".env.example", ".env.sample", ".env.template"]) {
    if (await fileExists(path.join(root, candidate))) return candidate;
  }
  return null;
}

async function installCommandFor(packageManager: PackageManager, root: string): Promise<string[]> {
  switch (packageManager) {
    case "pnpm":
      return ["pnpm", "install", "--frozen-lockfile"];
    case "npm":
      return ["npm", "ci"];
    case "yarn":
      return (await fileExists(path.join(root, ".yarnrc.yml")))
        ? ["yarn", "install", "--immutable"]
        : ["yarn", "install", "--frozen-lockfile"];
    case "bun":
      return ["bun", "install", "--frozen-lockfile"];
  }
}

function recommendedScripts(scripts: string[]): string[] {
  const preferred = ["lint", "typecheck", "test"].filter((script) => scripts.includes(script));
  if (preferred.length > 0) return preferred;
  return ["check", "verify"].filter((script) => scripts.includes(script));
}

async function anyFileExists(root: string, files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    if (await fileExists(path.join(root, file))) return true;
  }
  return false;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
