import type { Command } from "commander";
import { z } from "zod";
import { style } from "../../ui/style.js";
import type { CliContext } from "../context.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";
import { runProjectHook } from "./hook.js";

const setupInputSchema = z.object({ worktree: nonEmptyCliString.optional() }).strict();
export type SetupInput = z.output<typeof setupInputSchema>;

export function registerSetupCommand(program: Command, context: CliContext): void {
  program
    .command("setup")
    .description("Re-run the effective project configuration's post_create steps")
    .argument("[worktree]", "Worktree name, branch, or path")
    .addHelpText("after", "\nExample:\n  ygg setup feature-payment\n")
    .action(async (worktree: unknown) => {
      const input = parseCliInput(setupInputSchema, { worktree });
      await setupWorktree(input, context);
    });
}

export async function setupWorktree(input: SetupInput, context: CliContext): Promise<void> {
  await runProjectHook({ event: "post_create", worktree: input.worktree }, context, {
    emptyMessage: (_event, worktreeName) =>
      `No post_create setup is configured for ${worktreeName}.`,
    successMessage: (_event, worktreeName) => `Completed setup for ${style.worktree(worktreeName)}`,
  });
}
