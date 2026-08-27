import type { Command } from "commander";
import { z } from "zod";
import { YggError } from "../../domain/errors.js";
import { isInteractiveTerminal, promptText } from "../../ui/terminal.js";
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
    .addHelpText("after", "\nExample:\n  ygg exec feature-payment -- pnpm test\n")
    .action(async (worktree: unknown, command: unknown) => {
      const input = parseCliInput(execInputSchema, { worktree, command });
      const workspace = await context.workspaces.find();
      const selected = await resolveWorktree(workspace, input.worktree, context.worktrees);
      if (input.command.length > 0) {
        await context.processes.runInteractive(input.command, selected.path);
        return;
      }
      if (!isInteractiveTerminal()) {
        throw new YggError("Non-interactive execution requires: ygg exec <worktree> -- <command>");
      }
      const rawCommand = await promptText(`Command to run in ${selected.name}:`);
      if (!rawCommand) throw new YggError("Command cannot be empty.");
      writeLine(context.output.stderr, `Running through /bin/sh: ${rawCommand}`);
      await context.processes.runInteractiveShell(rawCommand, selected.path);
    });
}
