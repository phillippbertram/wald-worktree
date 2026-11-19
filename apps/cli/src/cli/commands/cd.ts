import type { Command } from "commander";
import { z } from "zod";
import type { CliContext } from "../context.js";
import { resolveWorktree, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const cdInputSchema = z.object({ worktree: nonEmptyCliString.optional() }).strict();

export function registerCdCommand(program: Command, context: CliContext): void {
  for (const [name, description] of [
    ["cd", "Enter a worktree with shell integration, or print its path"],
    ["path", "Print the canonical worktree path"],
  ] as const) {
    program
      .command(name)
      .description(description)
      .argument("[worktree]", "Worktree name, branch, or path")
      .action(async (worktree: unknown) => {
        const input = parseCliInput(cdInputSchema, { worktree });
        const workspace = await context.workspaces.find();
        const selected = await resolveWorktree(workspace, input.worktree, context, {
          promptOutput: process.stderr,
        });
        writeLine(context.output.stdout, selected.path);
      });
  }
}
