import type { Command } from "commander";
import { z } from "zod";
import { toErrorMessage, WtError } from "../../domain/errors.js";
import type { ProjectConfigDocument, Worktree } from "../../domain/types.js";
import { isInteractiveTerminal, searchSelect } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { ensureTrusted, resolveWorktree, success } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const openInputSchema = z
  .object({
    worktree: nonEmptyCliString.optional(),
    tool: nonEmptyCliString.optional(),
  })
  .strict();

export function registerOpenCommand(program: Command, context: CliContext): void {
  program
    .command("open")
    .description("Open a worktree in an editor, app, or agent tool")
    .argument("[worktree]", "Worktree name, branch, or path")
    .option("--tool <profile>", "Tool profile from built-ins or .wt.yaml")
    .action(async (worktree: unknown, options: unknown) => {
      const input = parseCliInput(openInputSchema, { worktree, ...(options as object) });
      const workspace = await context.workspaces.find();
      const selected = await resolveWorktree(workspace, input.worktree, context.worktrees);
      await openSelectedWorktree(selected, input.tool, context);
    });
}

export async function openSelectedWorktree(
  worktree: Worktree,
  requestedTool: string | undefined,
  context: CliContext,
  options: { silent?: boolean; project?: ProjectConfigDocument | null } = {},
): Promise<void> {
  const workspace = await context.workspaces.find();
  const project =
    options.project === undefined
      ? await context.workflow.projectForWorktree(worktree)
      : options.project;
  await ensureTrusted(workspace, project, context);
  const available = await context.tools.availableProfiles(project);
  if (available.length === 0) throw new WtError("No supported editor or agent tool is available.");
  let tool = requestedTool ?? project?.config.defaults.tool;
  if (!tool) {
    if (!isInteractiveTerminal()) throw new WtError("Tool is required without a TTY. Use --tool.");
    tool =
      (await searchSelect(
        `Open ${worktree.name} with:`,
        available.map(({ name, profile }) => ({
          label: name,
          value: name,
          description: profile.description,
        })),
      )) ?? undefined;
  }
  if (!tool) throw new WtError("No tool selected.");
  try {
    await context.tools.open(worktree, tool, project);
  } catch (error) {
    throw new WtError(`Could not open ${worktree.name} with ${tool}: ${toErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!options.silent) {
    await success(`Opened ${worktree.name} with ${tool}`, context.output);
  }
}
