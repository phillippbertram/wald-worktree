import type { Command } from "commander";
import { z } from "zod";
import { YggError } from "../../domain/errors.js";
import type { RemovePlan } from "../../services/worktree-workflow-service.js";
import { confirm, isInteractiveTerminal, selectManyWorktrees } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { ensureTrusted, removalError, success, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const removeInputSchema = z
  .object({
    worktrees: z.array(nonEmptyCliString).default([]),
    force: z.boolean().default(false),
    yes: z.boolean().default(false),
  })
  .strict();

export type RemoveInput = z.output<typeof removeInputSchema>;

export function registerRemoveCommand(program: Command, context: CliContext): void {
  program
    .command("remove")
    .description("Safely remove worktrees without deleting their branches")
    .argument("[worktrees...]", "Worktree names, branches, or paths")
    .option("--force", "Bypass dirty, unmerged, and lock safeguards")
    .option("--yes", "Confirm removal without prompting")
    .action(async (worktrees: unknown, options: unknown) => {
      const input = parseCliInput(removeInputSchema, {
        worktrees,
        ...(options as object),
      });
      await removeWorktrees(input, context);
    });
}

export async function removeWorktrees(input: RemoveInput, context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  let identifiers = input.worktrees;
  if (identifiers.length === 0) {
    if (!isInteractiveTerminal()) {
      throw new YggError("Non-interactive removal requires worktree names and --yes.");
    }
    const current = await context.worktrees.current(workspace);
    const candidates = (await context.worktrees.list(workspace)).filter(
      (worktree) => worktree.role !== "primary" && worktree.path !== current?.path,
    );
    identifiers = (await selectManyWorktrees("Select worktrees to remove:", candidates)).map(
      (worktree) => worktree.name,
    );
  }
  if (identifiers.length === 0) {
    writeLine(context.output.stdout, "Cancelled: no worktrees selected.");
    return;
  }

  const plans: RemovePlan[] = [];
  for (const identifier of identifiers) {
    const plan = await context.workflow.planRemove(workspace, identifier);
    if (plan.inspection.hardBlockers.length > 0) {
      throw removalError(plan.inspection.worktree, plan.inspection.hardBlockers);
    }
    if (plan.inspection.blockers.length > 0 && !input.force) {
      throw removalError(plan.inspection.worktree, [
        ...plan.inspection.blockers,
        "use --force only if this data can be discarded",
      ]);
    }
    await ensureTrusted(workspace, plan.project, context);
    plans.push(plan);
  }

  if (!input.yes) {
    if (!isInteractiveTerminal()) {
      throw new YggError("Non-interactive removal requires --yes.");
    }
    const accepted = await confirm(
      `Remove ${plans.map((plan) => plan.inspection.worktree.name).join(", ")}? Branches will be kept.`,
    );
    if (!accepted) {
      writeLine(context.output.stdout, "Cancelled.");
      return;
    }
  }

  for (const plan of plans) {
    await context.workflow.executeRemove(plan, {
      force: input.force,
      output: context.output.stderr,
    });
    await success(`Removed ${plan.inspection.worktree.name}`, context.output);
  }
}
