import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WaldError } from "../domain/errors.js";
import type { AutomationStep, ProjectConfig, ProjectConfigOverlay } from "../domain/types.js";

const packageJsonSchema = z
  .object({
    scripts: z.record(z.string(), z.string()).default({}),
    packageManager: z.string().optional(),
  })
  .passthrough();

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export type ProjectSetupInspection = {
  root: string;
  packageManager: PackageManager | null;
  installCommand: string[] | null;
  scripts: string[];
  recommendedScripts: string[];
  developmentScript: "dev" | null;
  environmentExample: string | null;
};

export type ProjectConfigTemplateOptions = {
  fetch: boolean;
  install: boolean;
  copyEnvironment: boolean;
  scripts: string[];
  development: boolean;
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
      developmentScript: scripts.includes("dev") ? "dev" : null,
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
        onExisting: "error",
        continueOnError: false,
      });
    }

    const selectedScripts = options.scripts.filter(
      (script) => script !== inspection.developmentScript && inspection.scripts.includes(script),
    );
    const taskRunner = inspection.packageManager ?? "npm";
    const tasks: ProjectConfig["tasks"] = {};
    if (selectedScripts.length > 0) {
      tasks.verify = {
        description: "Run the detected project checks",
        steps: selectedScripts.map((script) => ({
          type: "command",
          argv: [taskRunner, "run", script],
          cwd: "target",
          env: {},
          continueOnError: false,
        })),
      };
    }
    if (options.development && inspection.developmentScript) {
      tasks.dev = {
        description: "Start the detected development process",
        steps: [
          {
            type: "command",
            argv: [taskRunner, "run", inspection.developmentScript],
            cwd: "target",
            env: {},
            continueOnError: false,
          },
        ],
      };
    }
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
      tasks,
      tools: {},
    };
  }

  createWorkspaceOverlay(
    inspection: ProjectSetupInspection,
    options: ProjectConfigTemplateOptions,
  ): ProjectConfigOverlay {
    const generated = this.createConfig(inspection, options);
    const overlay: ProjectConfigOverlay = {
      version: 1,
      defaults: { fetch: generated.defaults.fetch },
    };
    if (generated.defaults.tool) {
      overlay.defaults = { ...overlay.defaults, tool: generated.defaults.tool };
    }
    if (generated.hooks.post_create.length > 0) {
      overlay.hooks = { post_create: generated.hooks.post_create };
    }
    if (Object.keys(generated.tasks).length > 0) overlay.tasks = generated.tasks;
    return overlay;
  }
}

async function detectPackageManager(root: string): Promise<PackageManager | null> {
  const declared = await readDeclaredPackageManager(root);
  if (declared) return declared;
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
    throw new WaldError(`Cannot read package metadata: ${packagePath}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new WaldError(`Package metadata is not valid JSON: ${packagePath}`, { cause: error });
  }
  const parsed = packageJsonSchema.safeParse(value);
  if (!parsed.success) {
    throw new WaldError(`Package scripts are invalid: ${packagePath}\n${parsed.error.message}`);
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
      return (await fileExists(path.join(root, "pnpm-lock.yaml")))
        ? ["pnpm", "install", "--frozen-lockfile"]
        : ["pnpm", "install"];
    case "npm":
      return (await anyFileExists(root, ["package-lock.json", "npm-shrinkwrap.json"]))
        ? ["npm", "ci"]
        : ["npm", "install"];
    case "yarn":
      if (!(await fileExists(path.join(root, "yarn.lock")))) return ["yarn", "install"];
      return (await fileExists(path.join(root, ".yarnrc.yml")))
        ? ["yarn", "install", "--immutable"]
        : ["yarn", "install", "--frozen-lockfile"];
    case "bun":
      return (await anyFileExists(root, ["bun.lock", "bun.lockb"]))
        ? ["bun", "install", "--frozen-lockfile"]
        : ["bun", "install"];
  }
}

async function readDeclaredPackageManager(root: string): Promise<PackageManager | null> {
  const packagePath = path.join(root, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(packagePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new WaldError(`Cannot read package metadata: ${packagePath}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new WaldError(`Package metadata is not valid JSON: ${packagePath}`, { cause: error });
  }
  const parsed = packageJsonSchema.safeParse(value);
  if (!parsed.success) {
    throw new WaldError(`Package metadata is invalid: ${packagePath}\n${parsed.error.message}`);
  }
  const declared = parsed.data.packageManager?.split("@", 1)[0];
  return declared === "pnpm" || declared === "npm" || declared === "yarn" || declared === "bun"
    ? declared
    : null;
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
