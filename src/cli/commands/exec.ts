import type { Command } from "commander";
import { z } from "zod";
import { WaldError } from "../../domain/errors.js";
import { style } from "../../ui/style.js";
import { isInteractiveTerminal, isPromptBackError, promptText } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { resolveWorktree, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const execInputSchema = z
  .object({
    worktree: nonEmptyCliString.optional(),
    command: z.array(z.string()).default([]),
  })
  .strict()
  .refine((input) => input.command.length === 0 || input.command[0] !== "", {
    message: "Executable cannot be empty.",
    path: ["command", 0],
  });

export function registerExecCommand(program: Command, context: CliContext): void {
  program
    .command("exec")
    .description("Run an ad-hoc command inside a worktree")
    .argument("[worktree]", "Worktree name, branch, or path")
    .argument("[command...]", "Command and arguments after --")
    .allowUnknownOption(true)
    .addHelpText("after", "\nExample:\n  wald exec feature-payment -- pnpm test\n")
    .action(async (worktree: unknown, command: unknown) => {
      const input = parseCliInput(execInputSchema, { worktree, command });
      await executeCommand(input, context);
    });
}

export async function executeCommand(
  input: z.output<typeof execInputSchema>,
  context: CliContext,
): Promise<void> {
  const workspace = await context.workspaces.find();
  const canChooseWorktree = !input.worktree && (await context.worktrees.list(workspace)).length > 1;
  let forcePrompt = false;
  let initialPath: string | undefined;
  let rawCommand: string | undefined;
  while (true) {
    const selected = await resolveWorktree(workspace, input.worktree, context.worktrees, {
      forcePrompt,
      initialPath,
      navigation: forcePrompt ? "cancel" : undefined,
    });
    initialPath = selected.path;
    if (input.command.length > 0) {
      await context.processes.runInteractive(input.command, selected.path);
      return;
    }
    if (!isInteractiveTerminal()) {
      throw new WaldError("Non-interactive execution requires: wald exec <worktree> -- <command>");
    }
    try {
      rawCommand = await promptText(
        `Execute › Command · Command to run in ${selected.name}:`,
        rawCommand,
        { navigation: canChooseWorktree ? "back" : "cancel" },
      );
    } catch (error) {
      if (!isPromptBackError(error) || !canChooseWorktree) throw error;
      forcePrompt = true;
      continue;
    }
    if (!rawCommand) throw new WaldError("Command cannot be empty.");
    writeLine(
      context.output.stderr,
      `${style.label("Running through /bin/sh:")} ${style.command(rawCommand)}`,
    );
    await context.processes.runInteractiveShell(rawCommand, selected.path);
    return;
  }
}
