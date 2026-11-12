import type { Command } from "commander";
import { z } from "zod";
import type { CliContext } from "../context.js";
import { resolveWorktree, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const cdInputSchema = z.object({ worktree: nonEmptyCliString.optional() }).strict();

export function registerCdCommand(program: Command, context: CliContext): void {
  program
    .command("cd")
    .description("Enter a worktree with shell integration, or print its path")
    .argument("[worktree]", "Worktree name, branch, or path")
    .action(async (worktree: unknown) => {
      const input = parseCliInput(cdInputSchema, { worktree });
      const workspace = await context.workspaces.find();
      const selected = await resolveWorktree(workspace, input.worktree, context.worktrees);
      writeLine(context.output.stdout, selected.path);
    });
}
