import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { WtError } from "../domain/errors.js";
import type {
  AutomationStep,
  ProjectConfig,
  ProjectConfigDocument,
  Workspace,
  WorkspaceConfig,
} from "../domain/types.js";
import type { GitClient } from "../infrastructure/git-client.js";

export const workspaceConfigFileName = "workspace.yml";
export const projectConfigFileName = ".wt.yml";

const workspaceRemoteFileSchema = z
  .object({
    name: z.string().min(1),
    fetch_refspec: z.string().min(1),
  })
  .strict();

const workspaceConfigFileSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["managed", "adopted"]),
    paths: z
      .object({
        git: z.string().min(1),
        worktrees: z.string().min(1),
        primary_worktree: z.string().min(1).nullable(),
      })
      .strict(),
    remote: workspaceRemoteFileSchema.nullable(),
    default_branch: z.string().min(1),
    trusted_project_config: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable()
      .default(null),
  })
  .strict();

const stepBaseShape = {
  continue_on_error: z.boolean().default(false),
};

const commandArgumentsFileSchema = z
  .array(z.string())
  .min(1)
  .refine((argv) => argv[0] !== "", "first argv entry must name an executable");

const commandStepFileSchema = z
  .object({
    type: z.literal("command"),
    argv: commandArgumentsFileSchema.optional(),
    shell: z.string().min(1).optional(),
    cwd: z.enum(["source", "target", "workspace"]).optional(),
    env: z.record(z.string(), z.string()).default({}),
    timeout_seconds: z.number().int().positive().max(86_400).optional(),
    ...stepBaseShape,
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.argv) === Boolean(value.shell)) {
      context.addIssue({
        code: "custom",
        message: "command steps require exactly one of 'argv' or 'shell'",
      });
    }
  });

const fileStepShape = {
  source: z.enum(["current", "default", "primary", "shared"]).default("default"),
  from: z.string().min(1),
  to: z.string().min(1),
  optional: z.boolean().default(false),
  overwrite: z.boolean().default(false),
  ...stepBaseShape,
};

const copyStepFileSchema = z
  .object({
    type: z.literal("copy"),
    ...fileStepShape,
  })
  .strict();

const symlinkStepFileSchema = z
  .object({
    type: z.literal("symlink"),
    ...fileStepShape,
  })
  .strict();

const automationStepFileSchema = z.union([
  commandStepFileSchema,
  copyStepFileSchema,
  symlinkStepFileSchema,
]);

const projectTaskFileSchema = z
  .object({
    description: z.string().min(1).optional(),
    steps: z.array(automationStepFileSchema).min(1),
  })
  .strict();

const toolProfileFileSchema = z
  .object({
    description: z.string().min(1).optional(),
    command: commandArgumentsFileSchema,
    mode: z.enum(["foreground", "detached"]).default("foreground"),
  })
  .strict();

const projectConfigFileSchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        fetch: z.boolean().default(true),
        tool: z.string().min(1).optional(),
      })
      .strict()
      .default({ fetch: true }),
    hooks: z
      .object({
        pre_create: z.array(automationStepFileSchema).default([]),
        post_create: z.array(automationStepFileSchema).default([]),
        pre_remove: z.array(automationStepFileSchema).default([]),
        post_remove: z.array(automationStepFileSchema).default([]),
      })
      .strict()
      .default({ pre_create: [], post_create: [], pre_remove: [], post_remove: [] }),
    tasks: z.record(z.string().min(1), projectTaskFileSchema).default({}),
    tools: z.record(z.string().min(1), toolProfileFileSchema).default({}),
  })
  .strict();

type WorkspaceConfigFile = z.infer<typeof workspaceConfigFileSchema>;
type ProjectConfigFile = z.infer<typeof projectConfigFileSchema>;
type AutomationStepFile = z.infer<typeof automationStepFileSchema>;

export class ConfigService {
  async readWorkspaceConfig(configPath: string): Promise<WorkspaceConfig> {
    const parsed = workspaceConfigFileSchema.safeParse(await this.readYaml(configPath));
    if (!parsed.success) {
      throw invalidConfigurationError(configPath, parsed.error);
    }
    return fromWorkspaceConfigFile(parsed.data);
  }

  async writeWorkspaceConfig(configPath: string, config: WorkspaceConfig): Promise<void> {
    const parsed = workspaceConfigFileSchema.safeParse(toWorkspaceConfigFile(config));
    if (!parsed.success) {
      throw invalidConfigurationError(configPath, parsed.error);
    }

    await fs.mkdir(path.dirname(configPath), { mode: 0o700, recursive: true });
    const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, stringify(parsed.data, { indent: 2, lineWidth: 0 }), {
        mode: 0o600,
      });
      await fs.rename(temporaryPath, configPath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  async readProjectConfig(root: string): Promise<ProjectConfigDocument | null> {
    const configPath = path.join(root, projectConfigFileName);
    try {
      return this.parseProjectConfig(await fs.readFile(configPath, "utf8"), configPath);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeProjectConfig(
    root: string,
    config: ProjectConfig,
    options: { overwrite?: boolean } = {},
  ): Promise<ProjectConfigDocument> {
    const configPath = path.join(root, projectConfigFileName);
    const content = this.formatProjectConfig(config);
    if (!options.overwrite) {
      try {
        await fs.writeFile(configPath, content, { flag: "wx", mode: 0o644 });
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new WtError(`Project configuration already exists: ${configPath}`);
        }
        throw new WtError(`Cannot write project configuration: ${configPath}`, { cause: error });
      }
      return this.parseProjectConfig(content, configPath);
    }

    const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, content, { mode: 0o644 });
      await fs.rename(temporaryPath, configPath);
    } catch (error) {
      throw new WtError(`Cannot write project configuration: ${configPath}`, { cause: error });
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
    return this.parseProjectConfig(content, configPath);
  }

  async readProjectConfigAtRevision(
    git: GitClient,
    workspace: Workspace,
    revision: string,
  ): Promise<ProjectConfigDocument | null> {
    const result = await git.run(["show", `${revision}:${projectConfigFileName}`], {
      gitDir: workspace.gitDir,
      reject: false,
      stripFinalNewline: false,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    return this.parseProjectConfig(result.stdout, `${revision}:${projectConfigFileName}`);
  }

  parseProjectConfig(raw: string, configPath: string): ProjectConfigDocument {
    const parsed = projectConfigFileSchema.safeParse(parseYaml(raw, configPath));
    if (!parsed.success) {
      throw invalidConfigurationError(configPath, parsed.error);
    }
    const config = fromProjectConfigFile(parsed.data);
    return {
      config,
      hash: semanticHash(config),
      path: configPath,
      requiresTrust: projectConfigRequiresTrust(config),
    };
  }

  isTrusted(workspace: Workspace, document: ProjectConfigDocument | null): boolean {
    return !document?.requiresTrust || workspace.config.trustedProjectConfig === document.hash;
  }

  async trust(workspace: Workspace, document: ProjectConfigDocument): Promise<void> {
    workspace.config.trustedProjectConfig = document.hash;
    await this.writeWorkspaceConfig(workspace.configPath, workspace.config);
  }

  async untrust(workspace: Workspace): Promise<void> {
    workspace.config.trustedProjectConfig = null;
    await this.writeWorkspaceConfig(workspace.configPath, workspace.config);
  }

  formatWorkspaceConfig(config: WorkspaceConfig): string {
    return stringify(toWorkspaceConfigFile(config), { indent: 2, lineWidth: 0 });
  }

  formatProjectConfig(config: ProjectConfig): string {
    const parsed = projectConfigFileSchema.safeParse(toProjectConfigFile(config));
    if (!parsed.success) {
      throw invalidConfigurationError(projectConfigFileName, parsed.error);
    }
    return stringify(parsed.data, { indent: 2, lineWidth: 0 });
  }

  private async readYaml(configPath: string): Promise<unknown> {
    let raw: string;
    try {
      raw = await fs.readFile(configPath, "utf8");
    } catch (error) {
      throw new WtError(`Cannot read workspace configuration: ${configPath}`, { cause: error });
    }
    return parseYaml(raw, configPath);
  }
}

export function summarizeExecutableConfig(document: ProjectConfigDocument): string[] {
  const rows: string[] = [];
  for (const [event, steps] of Object.entries(document.config.hooks)) {
    if (steps.length > 0) {
      rows.push(`hook ${event}: ${steps.map(describeStep).join(", ")}`);
    }
  }
  for (const [name, task] of Object.entries(document.config.tasks)) {
    rows.push(`task ${name}: ${task.steps.map(describeStep).join(", ")}`);
  }
  for (const [name, tool] of Object.entries(document.config.tools)) {
    rows.push(`tool ${name}: ${tool.command.join(" ")}`);
  }
  return rows;
}

function parseYaml(raw: string, configPath: string): unknown {
  const document = parseDocument(raw, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new WtError(
      `Configuration is not valid YAML: ${configPath}\n${document.errors.map((error) => error.message).join("\n")}`,
    );
  }
  return document.toJS();
}

function fromWorkspaceConfigFile(file: WorkspaceConfigFile): WorkspaceConfig {
  return {
    version: 1,
    mode: file.mode,
    paths: {
      git: file.paths.git,
      worktrees: file.paths.worktrees,
      primaryWorktree: file.paths.primary_worktree,
    },
    remote: file.remote
      ? { name: file.remote.name, fetchRefspec: file.remote.fetch_refspec }
      : null,
    defaultBranch: file.default_branch,
    trustedProjectConfig: file.trusted_project_config,
  };
}

function toWorkspaceConfigFile(config: WorkspaceConfig): WorkspaceConfigFile {
  return {
    version: 1,
    mode: config.mode,
    paths: {
      git: config.paths.git,
      worktrees: config.paths.worktrees,
      primary_worktree: config.paths.primaryWorktree,
    },
    remote: config.remote
      ? { name: config.remote.name, fetch_refspec: config.remote.fetchRefspec }
      : null,
    default_branch: config.defaultBranch,
    trusted_project_config: config.trustedProjectConfig,
  };
}

function fromProjectConfigFile(file: ProjectConfigFile): ProjectConfig {
  return {
    version: 1,
    defaults: {
      fetch: file.defaults.fetch,
      tool: file.defaults.tool,
    },
    hooks: {
      pre_create: file.hooks.pre_create.map(fromAutomationStepFile),
      post_create: file.hooks.post_create.map(fromAutomationStepFile),
      pre_remove: file.hooks.pre_remove.map(fromAutomationStepFile),
      post_remove: file.hooks.post_remove.map(fromAutomationStepFile),
    },
    tasks: Object.fromEntries(
      Object.entries(file.tasks).map(([name, task]) => [
        name,
        {
          description: task.description,
          steps: task.steps.map(fromAutomationStepFile),
        },
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(file.tools).map(([name, tool]) => [
        name,
        {
          description: tool.description,
          command: tool.command,
          mode: tool.mode,
        },
      ]),
    ),
  };
}

function toProjectConfigFile(config: ProjectConfig): ProjectConfigFile {
  return {
    version: 1,
    defaults: {
      fetch: config.defaults.fetch,
      tool: config.defaults.tool,
    },
    hooks: {
      pre_create: config.hooks.pre_create.map(toAutomationStepFile),
      post_create: config.hooks.post_create.map(toAutomationStepFile),
      pre_remove: config.hooks.pre_remove.map(toAutomationStepFile),
      post_remove: config.hooks.post_remove.map(toAutomationStepFile),
    },
    tasks: Object.fromEntries(
      Object.entries(config.tasks).map(([name, task]) => [
        name,
        {
          description: task.description,
          steps: task.steps.map(toAutomationStepFile),
        },
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(config.tools).map(([name, tool]) => [
        name,
        {
          description: tool.description,
          command: tool.command,
          mode: tool.mode,
        },
      ]),
    ),
  };
}

function fromAutomationStepFile(step: AutomationStepFile): AutomationStep {
  if (step.type === "command") {
    return {
      type: "command",
      argv: step.argv,
      shell: step.shell,
      cwd: step.cwd,
      env: step.env,
      timeoutSeconds: step.timeout_seconds,
      continueOnError: step.continue_on_error,
    };
  }
  return {
    type: step.type,
    source: step.source,
    from: step.from,
    to: step.to,
    optional: step.optional,
    overwrite: step.overwrite,
    continueOnError: step.continue_on_error,
  };
}

function toAutomationStepFile(step: AutomationStep): AutomationStepFile {
  if (step.type === "command") {
    return {
      type: "command",
      argv: step.argv,
      shell: step.shell,
      cwd: step.cwd,
      env: step.env,
      timeout_seconds: step.timeoutSeconds,
      continue_on_error: step.continueOnError,
    };
  }
  return {
    type: step.type,
    source: step.source,
    from: step.from,
    to: step.to,
    optional: step.optional,
    overwrite: step.overwrite,
    continue_on_error: step.continueOnError,
  };
}

function invalidConfigurationError(configPath: string, error: z.ZodError): WtError {
  const details = error.issues
    .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
    .join("\n");
  return new WtError(`Configuration is invalid: ${configPath}\n${details}`);
}

function semanticHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function projectConfigRequiresTrust(config: ProjectConfig): boolean {
  return (
    Object.values(config.hooks).some((steps) => steps.length > 0) ||
    Object.keys(config.tasks).length > 0 ||
    Object.keys(config.tools).length > 0
  );
}

function describeStep(step: AutomationStep): string {
  if (step.type === "command") {
    return step.argv?.join(" ") ?? step.shell ?? "command";
  }
  return `${step.type} ${step.source}:${step.from} -> ${step.to}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
