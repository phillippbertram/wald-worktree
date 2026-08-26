import type { Command } from "commander";
import { z } from "zod";
import { WtError } from "../../domain/errors.js";
import { confirm, isInteractiveTerminal } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { printTrustSummary, resolveProjectConfiguration, success, writeLine } from "../helpers.js";
import { parseCliInput } from "../input.js";

const confirmationInputSchema = z.object({ yes: z.boolean().default(false) }).strict();

export function registerConfigCommand(program: Command, context: CliContext): void {
  const config = program
    .command("config")
    .description("Show and trust YAML configuration")
    .action(async () => showConfiguration(context));

  config
    .command("trust")
    .description("Trust the current project configuration")
    .option("--yes", "Trust without prompting")
    .action(async (options: unknown) => {
      const input = parseCliInput(confirmationInputSchema, options);
      const workspace = await context.workspaces.find();
      const project = await resolveProjectConfiguration(workspace, context);
      if (!project) throw new WtError("No .wt.yaml found on the current or default branch.");
      printTrustSummary(project, context.output);
      if (!input.yes) {
        if (!isInteractiveTerminal()) throw new WtError("Non-interactive trust requires --yes.");
        if (!(await confirm("Trust this project configuration until its behavior changes?"))) {
          writeLine(context.output.stdout, "Cancelled.");
          return;
        }
      }
      await context.configs.trust(workspace, project);
      await success(`Trusted ${project.path}`, context.output);
    });

  config
    .command("untrust")
    .description("Remove project configuration trust")
    .option("--yes", "Remove trust without prompting")
    .action(async (options: unknown) => {
      const input = parseCliInput(confirmationInputSchema, options);
      const workspace = await context.workspaces.find();
      if (!input.yes) {
        if (!isInteractiveTerminal()) throw new WtError("Non-interactive untrust requires --yes.");
        if (!(await confirm("Remove trust for the project configuration?"))) return;
      }
      await context.configs.untrust(workspace);
      await success("Project configuration is no longer trusted.", context.output);
    });
}

export async function showConfiguration(context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  context.output.stdout.write(context.configs.formatWorkspaceConfig(workspace.config));
  const project = await resolveProjectConfiguration(workspace, context);
  writeLine(context.output.stdout, `project_config: ${project?.path ?? "none"}`);
  writeLine(context.output.stdout, `project_hash: ${project?.hash ?? "none"}`);
  writeLine(context.output.stdout, `trusted: ${context.configs.isTrusted(workspace, project)}`);
}
