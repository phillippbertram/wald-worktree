import type { Command } from "commander";
import { z } from "zod";
import { WaldError } from "../../domain/errors.js";
import { style } from "../../ui/style.js";
import { isInteractiveTerminal, isPromptBackError, searchSelect } from "../../ui/terminal.js";
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
    .description("Run a named project task in a worktree")
    .argument("[task]", "Task name from the effective project configuration")
    .argument("[worktree]", "Worktree name, branch, or path")
    .addHelpText(
      "after",
      "\nExamples:\n  wald run verify feature-payment\n  wald run dev feature-payment\n",
    )
    .action(async (task: unknown, worktree: unknown) => {
      await runProjectTask(parseCliInput(runInputSchema, { task, worktree }), context);
    });
}

export async function runProjectTask(input: RunInput, context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  const canChooseWorktree = !input.worktree && (await context.worktrees.list(workspace)).length > 1;
  let forcePrompt = false;
  let initialPath: string | undefined;
  let selectedTask: string | undefined;
  while (true) {
    const worktree = await resolveWorktree(workspace, input.worktree, context.worktrees, {
      forcePrompt,
      initialPath,
      navigation: forcePrompt ? "cancel" : undefined,
    });
    initialPath = worktree.path;
    const project = await context.workflow.projectForWorktree(workspace, worktree);
    if (!project) throw new WaldError(`No project configuration found for ${worktree.path}`);
    if (Object.keys(project.config.tasks).length === 0) {
      throw new WaldError("No tasks are configured in the effective project configuration.");
    }
    while (true) {
      let task = input.task;
      if (!task) {
        if (!isInteractiveTerminal()) throw new WaldError("Task is required without a TTY.");
        try {
          task = await searchSelect(
            `Run › Task · Select a task for ${style.worktree(worktree.name)}:`,
            Object.entries(project.config.tasks).map(([name, definition]) => ({
              label: style.value(name),
              value: name,
              description: definition.description,
            })),
            {
              navigation: canChooseWorktree ? "back" : "cancel",
              initialValue: selectedTask,
            },
          );
          selectedTask = task;
        } catch (error) {
          if (!isPromptBackError(error) || !canChooseWorktree) throw error;
          forcePrompt = true;
          break;
        }
      }
      try {
        await ensureTrusted(workspace, project, context, {
          navigation: input.task ? "cancel" : "back",
        });
      } catch (error) {
        if (!isPromptBackError(error) || input.task) throw error;
        continue;
      }
      await context.workflow.runTask(workspace, worktree, task, {
        output: context.output.stderr,
      });
      await success(
        `Completed task ${style.value(task)} in ${style.worktree(worktree.name)}`,
        context.output,
      );
      return;
    }
  }
}
