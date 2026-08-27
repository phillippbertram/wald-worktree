import type { Command } from "commander";
import { z } from "zod";
import { YggError } from "../../domain/errors.js";
import { isPromptBackError } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { ensureTrusted, resolveWorktree, success } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const setupInputSchema = z.object({ worktree: nonEmptyCliString.optional() }).strict();
export type SetupInput = z.output<typeof setupInputSchema>;

export function registerSetupCommand(program: Command, context: CliContext): void {
  program
    .command("setup")
    .description("Re-run the configured .ygg.yml post_create steps")
    .argument("[worktree]", "Worktree name, branch, or path")
    .addHelpText("after", "\nExample:\n  ygg setup feature-payment\n")
    .action(async (worktree: unknown) => {
      const input = parseCliInput(setupInputSchema, { worktree });
      await setupWorktree(input, context);
    });
}

export async function setupWorktree(input: SetupInput, context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  const canChooseWorktree = !input.worktree && (await context.worktrees.list(workspace)).length > 1;
  let forcePrompt = false;
  let initialPath: string | undefined;
  while (true) {
    const selected = await resolveWorktree(workspace, input.worktree, context.worktrees, {
      forcePrompt,
      initialPath,
      navigation: forcePrompt ? "cancel" : undefined,
    });
    initialPath = selected.path;
    const project = await context.workflow.projectForWorktree(selected);
    if (!project || project.config.hooks.post_create.length === 0) {
      throw new YggError(`No post_create setup is configured for ${selected.name}.`);
    }
    try {
      await ensureTrusted(workspace, project, context, {
        navigation: canChooseWorktree ? "back" : "cancel",
      });
    } catch (error) {
      if (!isPromptBackError(error) || !canChooseWorktree) throw error;
      forcePrompt = true;
      continue;
    }
    await context.workflow.runHook(workspace, selected, "post_create", {
      output: context.output.stderr,
    });
    await success(`Completed setup for ${selected.name}`, context.output);
    return;
  }
}
