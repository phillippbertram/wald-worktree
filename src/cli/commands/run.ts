import type { Command } from "commander";
import { z } from "zod";
import { WtError } from "../../domain/errors.js";
import { isInteractiveTerminal, searchSelect } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { ensureTrusted, resolveWorktree, success } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const runInputSchema = z
  .object({
    task: nonEmptyCliString.optional(),
    worktree: nonEmptyCliString.optional(),
  })
  .strict();

export type RunInput = z.output<typeof runInputSchema>;

export function registerRunCommand(program: Command, context: CliContext): void {
  program
    .command("run")
    .description("Run a named project task")
    .argument("[task]", "Task name from .wt.yml")
    .argument("[worktree]", "Worktree name, branch, or path")
    .action(async (task: unknown, worktree: unknown) => {
      await runProjectTask(parseCliInput(runInputSchema, { task, worktree }), context);
    });
}

export async function runProjectTask(input: RunInput, context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  const worktree = await resolveWorktree(workspace, input.worktree, context.worktrees);
  const project = await context.workflow.projectForWorktree(worktree);
  if (!project) throw new WtError(`No .wt.yml found in ${worktree.path}`);
  await ensureTrusted(workspace, project, context);
  let task = input.task;
  if (!task) {
    if (Object.keys(project.config.tasks).length === 0) {
      throw new WtError("No tasks are configured in .wt.yml.");
    }
    if (!isInteractiveTerminal()) throw new WtError("Task is required without a TTY.");
    task =
      (await searchSelect(
        `Select a task for ${worktree.name}:`,
        Object.entries(project.config.tasks).map(([name, definition]) => ({
          label: name,
          value: name,
          description: definition.description,
        })),
      )) ?? undefined;
  }
  if (!task) throw new WtError("No task selected.");
  await context.workflow.runTask(workspace, worktree, task, {
    output: context.output.stderr,
  });
  await success(`Completed task ${task} in ${worktree.name}`, context.output);
}
