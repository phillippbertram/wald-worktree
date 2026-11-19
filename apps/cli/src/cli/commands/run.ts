import type { Command } from "commander";
import { z } from "zod";
import { WaldError } from "../../domain/errors.js";
import { sanitizeTerminalText } from "../../infrastructure/safe-text.js";
import { style } from "../../ui/style.js";
import { isPromptBackError, searchSelect } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { ensureTrusted, resolveWorktree, success, writeJson, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";
import { offerProjectConfiguration } from "./config.js";

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
    .option("--list", "List configured tasks for the optional worktree without executing them")
    .option("--json", "Emit the task list as JSON (requires --list)")
    .addHelpText(
      "after",
      "\nExamples:\n  wald run verify feature-payment\n  wald run --list\n  wald run --list feature-payment --json\n",
    )
    .action(
      async (task: unknown, worktree: unknown, options: { list?: boolean; json?: boolean }) => {
        const input = parseCliInput(runInputSchema, { task, worktree });
        if (options.list) {
          if (input.worktree)
            throw new WaldError(
              "Task listing accepts at most one worktree: wald run --list [worktree].",
            );
          await listProjectTasks(input.task, options.json === true, context);
          return;
        }
        if (options.json) throw new WaldError("Task JSON output requires --list.");
        await runProjectTask(input, context);
      },
    );
}

async function listProjectTasks(
  identifier: string | undefined,
  json: boolean,
  context: CliContext,
) {
  const workspace = await context.workspaces.find();
  const selected = await resolveWorktree(workspace, identifier, context);
  const project = await context.workflow.projectForWorktree(workspace, selected);
  const configured = project?.config.tasks ?? {};
  const tasks = Object.keys(configured)
    .sort()
    .map((name) => ({ name, description: configured[name]?.description ?? null }));
  if (json) {
    writeJson(context.output.stdout, { worktree: selected.path, tasks });
    return;
  }
  if (tasks.length === 0) writeLine(context.output.stdout, "No tasks configured.");
  for (const { name, description } of tasks) {
    writeLine(
      context.output.stdout,
      sanitizeTerminalText(description ? `${name}  ${description}` : name),
    );
  }
}

export async function runProjectTask(input: RunInput, context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  const canChooseWorktree = !input.worktree && (await context.worktrees.list(workspace)).length > 1;
  let forcePrompt = false;
  let initialPath: string | undefined;
  let selectedTask: string | undefined;
  while (true) {
    const worktree = await resolveWorktree(workspace, input.worktree, context, {
      forcePrompt,
      initialPath,
      navigation: forcePrompt ? "cancel" : undefined,
    });
    initialPath = worktree.path;
    const project = await context.workflow.projectForWorktree(workspace, worktree);
    if (!project || Object.keys(project.config.tasks).length === 0) {
      const message = project
        ? "No tasks are configured in the effective project configuration."
        : `No project configuration found for ${worktree.path}`;
      if (input.task || !context.canPrompt()) throw new WaldError(message);
      if (await offerProjectConfiguration(worktree, "No project tasks configured.", context))
        continue;
      return;
    }
    while (true) {
      let task = input.task;
      if (!task) {
        if (!context.canPrompt()) throw new WaldError("Specify a task name.");
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
