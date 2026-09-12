import type { Command } from "commander";
import { z } from "zod";
import { isInteractiveTerminal, printWorktreeTable, runTask } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { printPlainWorktrees, writeJson, writeLine } from "../helpers.js";
import { parseCliInput } from "../input.js";

const listInputSchema = z.object({ json: z.boolean().default(false) }).strict();
export type ListInput = z.output<typeof listInputSchema>;

export function registerListCommand(program: Command, context: CliContext): void {
  program
    .command("list")
    .alias("ls")
    .description("List worktrees with branch, role, status, and path")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: unknown) => {
      await listWorktrees(parseCliInput(listInputSchema, options), context);
    });
}

export async function listWorktrees(input: ListInput, context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  const worktrees = await runTask("Reading worktrees", () => context.worktrees.list(workspace));
  if (input.json) writeJson(context.output.stdout, worktrees);
  else if (worktrees.length === 0) {
    writeLine(context.output.stdout, "No worktrees yet. Run wald create <branch> to create one.");
  } else if (isInteractiveTerminal()) await printWorktreeTable(worktrees);
  else printPlainWorktrees(worktrees, context.output.stdout);
}
