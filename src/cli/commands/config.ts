import type { Command } from "commander";
import { z } from "zod";
import { WaldError } from "../../domain/errors.js";
import { workspaceProjectConfigPath } from "../../services/config-service.js";
import { style } from "../../ui/style.js";
import { confirm, isInteractiveTerminal, isPromptBackError } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import {
  printTrustSummary,
  resolveProjectConfiguration,
  resolveWorktree,
  success,
  writeLine,
} from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";
import { initializeProjectConfiguration } from "../project-config-wizard.js";

const confirmationInputSchema = z.object({ yes: z.boolean().default(false) }).strict();
const showInputSchema = z.object({ json: z.boolean().default(false) }).strict();
const initializationInputSchema = z
  .object({
    worktree: nonEmptyCliString.optional(),
    force: z.boolean().default(false),
    yes: z.boolean().default(false),
    scope: z.enum(["workspace", "project"]).default("workspace"),
    fromProject: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.fromProject && value.scope !== "workspace") {
      context.addIssue({
        code: "custom",
        path: ["fromProject"],
        message: "Requires --scope workspace.",
      });
    }
  });

export type ProjectConfigInitializationInput = z.output<typeof initializationInputSchema>;

export function registerConfigCommand(program: Command, context: CliContext): void {
  const config = program
    .command("config")
    .description("Show or manage workspace-local and repository project configuration")
    .option("--json", "Print machine-readable configuration details")
    .action(async (options: unknown) =>
      showConfiguration(context, parseCliInput(showInputSchema, options).json),
    );

  config
    .command("init")
    .description("Create workspace-local project configuration by default")
    .argument("[worktree]", "Worktree name, branch, or path")
    .option("--scope <scope>", "Write to workspace or project", "workspace")
    .option("--from-project", "Copy the complete .wald.yml into workspace configuration")
    .option("--yes", "Use detected defaults without prompting")
    .option("--force", "Replace an existing configuration at the selected scope")
    .action(async (worktree: unknown, options: unknown) => {
      const input = parseCliInput(initializationInputSchema, {
        worktree,
        ...(options as object),
      });
      await initializeProjectConfigurationForWorktree(input, context);
    });

  config
    .command("trust")
    .description("Trust the current project configuration")
    .option("--yes", "Trust without prompting")
    .action(async (options: unknown) => {
      const input = parseCliInput(confirmationInputSchema, options);
      const workspace = await context.workspaces.find();
      const project = await resolveProjectConfiguration(workspace, context);
      if (!project) throw new WaldError("No effective project configuration found.");
      printTrustSummary(project, context.output);
      if (!input.yes) {
        if (!isInteractiveTerminal()) throw new WaldError("Non-interactive trust requires --yes.");
        if (!(await confirm("Trust this project configuration until its behavior changes?"))) {
          writeLine(context.output.stdout, "Cancelled.");
          return;
        }
      }
      await context.configs.trust(workspace, project);
      await success(`Trusted ${style.path(project.path)}`, context.output);
    });

  config
    .command("untrust")
    .description("Remove project configuration trust")
    .option("--yes", "Remove trust without prompting")
    .action(async (options: unknown) => {
      const input = parseCliInput(confirmationInputSchema, options);
      const workspace = await context.workspaces.find();
      if (!input.yes) {
        if (!isInteractiveTerminal())
          throw new WaldError("Non-interactive untrust requires --yes.");
        if (!(await confirm("Remove trust for the project configuration?"))) return;
      }
      await context.configs.untrust(workspace);
      await success("Project configuration is no longer trusted.", context.output);
    });
}

export async function initializeProjectConfigurationForWorktree(
  input: ProjectConfigInitializationInput,
  context: CliContext,
): Promise<void> {
  const workspace = await context.workspaces.find();
  const canChooseWorktree = !input.worktree && (await context.worktrees.list(workspace)).length > 1;
  let forcePrompt = false;
  let initialPath: string | undefined;
  while (true) {
    const selected = await resolveWorktree(workspace, input.worktree, context.worktrees, {
      forcePrompt,
      initialPath,
      navigation: forcePrompt ? "cancel" : undefined,
    });
    initialPath = selected.path;
    try {
      await initializeProjectConfiguration(workspace, selected.path, input, context);
      return;
    } catch (error) {
      if (!isPromptBackError(error) || !canChooseWorktree) throw error;
      forcePrompt = true;
    }
  }
}

export async function showConfiguration(context: CliContext, json = false): Promise<void> {
  const workspace = await context.workspaces.find();
  const project = await resolveProjectConfiguration(workspace, context);
  const trusted = context.configs.isTrusted(workspace, project);
  if (json) {
    writeLine(
      context.output.stdout,
      JSON.stringify({
        workspaceConfig: workspace.config,
        paths: {
          workspaceConfig: workspace.configPath,
          workspaceRoot: workspace.root,
          worktrees: workspace.worktreeDir,
          shared: workspace.sharedDir,
          workspaceProjectConfig: workspaceProjectConfigPath(workspace),
        },
        project: project
          ? { path: project.path, sources: project.sources, hash: project.hash, trusted }
          : null,
      }),
    );
    return;
  }
  context.output.stdout.write(context.configs.formatWorkspaceConfig(workspace.config));
  writeConfigurationField(context.output.stdout, "workspace_config", workspace.configPath, "path");
  writeConfigurationField(context.output.stdout, "workspace_root", workspace.root, "path");
  writeConfigurationField(context.output.stdout, "worktrees_path", workspace.worktreeDir, "path");
  writeConfigurationField(context.output.stdout, "shared_path", workspace.sharedDir, "path");
  writeConfigurationField(
    context.output.stdout,
    "repository_project_config",
    project?.sources.repository ?? "none",
    "path",
  );
  writeConfigurationField(
    context.output.stdout,
    "workspace_project_config",
    project?.sources.workspace ?? "none",
    "path",
  );
  writeConfigurationField(
    context.output.stdout,
    "workspace_project_config_path",
    workspaceProjectConfigPath(workspace),
    "path",
  );
  writeConfigurationField(context.output.stdout, "project_config", project?.path ?? "none", "path");
  writeConfigurationField(context.output.stdout, "project_hash", project?.hash ?? "none", "hash");
  writeConfigurationField(
    context.output.stdout,
    "effective_project_hash",
    project?.hash ?? "none",
    "hash",
  );
  writeLine(
    context.output.stdout,
    `${style.label("trusted:")} ${(trusted ? style.success : style.danger)(String(trusted))}`,
  );
}

function writeConfigurationField(
  stream: NodeJS.WritableStream,
  key: string,
  value: string,
  kind: "hash" | "path",
): void {
  writeLine(stream, `${style.label(`${key}:`)} ${style[kind](value)}`);
}
