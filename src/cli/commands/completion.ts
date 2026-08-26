import type { Command } from "commander";
import { z } from "zod";
import type { CliContext } from "../context.js";
import { findWorkspaceOrNull, writeLine } from "../helpers.js";
import { parseCliInput } from "../input.js";

const completionInputSchema = z
  .object({ kind: z.enum(["worktrees", "branches", "tasks", "tools"]) })
  .strict();

export function registerCompletionCommand(program: Command, context: CliContext): void {
  program
    .command("completion", { hidden: true })
    .argument("<kind>", "worktrees, branches, tasks, or tools")
    .action(async (kind: unknown) => {
      const input = parseCliInput(completionInputSchema, { kind });
      await printCompletionCandidates(input.kind, context);
    });
}

async function printCompletionCandidates(
  kind: z.output<typeof completionInputSchema>["kind"],
  context: CliContext,
): Promise<void> {
  const workspace = await findWorkspaceOrNull(context);
  if (!workspace) return;
  const worktrees = await context.worktrees.list(workspace);
  if (kind === "worktrees") {
    for (const worktree of worktrees) writeLine(context.output.stdout, worktree.name);
    return;
  }
  if (kind === "branches") {
    const names = new Set(
      (await context.worktrees.listBranchCandidates(workspace)).map((item) => item.name),
    );
    for (const name of [...names].sort()) writeLine(context.output.stdout, name);
    return;
  }
  const worktree = (await context.worktrees.current(workspace)) ?? worktrees[0];
  if (!worktree) return;
  const project = await context.configs.readProjectConfig(worktree.path);
  if (kind === "tasks") {
    for (const name of Object.keys(project?.config.tasks ?? {}).sort())
      writeLine(context.output.stdout, name);
    return;
  }
  for (const { name } of await context.tools.availableProfiles(project))
    writeLine(context.output.stdout, name);
}
