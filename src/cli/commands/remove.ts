import type { Command } from "commander";
import { z } from "zod";
import { WaldError } from "../../domain/errors.js";
import type { BranchDeletionPlan } from "../../services/worktree-service.js";
import type { RemovePlan } from "../../services/worktree-workflow-service.js";
import { style } from "../../ui/style.js";
import {
  confirm,
  isInteractiveTerminal,
  isPromptBackError,
  selectManyValues,
  selectManyWorktrees,
} from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { ensureTrusted, removalError, success, writeJson, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const removeInputSchema = z
  .object({
    worktrees: z.array(nonEmptyCliString).default([]),
    force: z.boolean().default(false),
    deleteBranch: z.boolean().default(false),
    yes: z.boolean().default(false),
    json: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.json && (input.worktrees.length === 0 || !input.yes)) {
      context.addIssue({
        code: "custom",
        path: ["json"],
        message: "JSON mode requires worktree names and --yes.",
      });
    }
  });

export type RemoveInput = Omit<z.output<typeof removeInputSchema>, "json"> & { json?: boolean };

export function registerRemoveCommand(program: Command, context: CliContext): void {
  program
    .command("remove")
    .description("Safely remove worktrees and optionally their local branches")
    .argument("[worktrees...]", "Worktree names, branches, or paths")
    .option("--force", "Bypass dirty, unmerged, and lock safeguards")
    .option(
      "--delete-branch",
      "Delete each removed worktree's eligible local branch; unmerged branches require --force",
    )
    .option("--yes", "Confirm removal without prompting")
    .option("--json", "Emit machine-readable JSON without prompting")
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
  const promptedForSelection = input.worktrees.length === 0;
  let identifiers = input.worktrees;
  let previousSelectionPaths: string[] = [];
  let previousBranchRefs: string[] = [];

  while (true) {
    if (promptedForSelection) {
      if (!isInteractiveTerminal()) {
        throw new WaldError("Non-interactive removal requires worktree names and --yes.");
      }
      const current = await context.worktrees.current(workspace);
      const candidates = (await context.worktrees.list(workspace)).filter(
        (worktree) => worktree.role !== "primary" && worktree.path !== current?.path,
      );
      if (candidates.length === 0) {
        writeLine(context.output.stdout, "No removable worktrees found.");
        return;
      }
      const selected = await selectManyWorktrees(
        "Remove › Worktrees · Select worktrees to remove:",
        candidates,
        { navigation: "cancel", initialValues: previousSelectionPaths },
      );
      previousSelectionPaths = selected.map((worktree) => worktree.path);
      identifiers = selected.map((worktree) => worktree.name);
    }
    if (identifiers.length === 0) {
      writeLine(context.output.stdout, "Cancelled: no worktrees selected.");
      return;
    }

    const plansByPath = new Map<string, RemovePlan>();
    for (const identifier of identifiers) {
      const plan = await context.workflow.planRemove(workspace, identifier);
      plansByPath.set(plan.inspection.worktree.path, plan);
    }
    const plans = [...plansByPath.values()];

    for (const plan of plans) {
      if (plan.inspection.hardBlockers.length > 0) {
        throw removalError(plan.inspection.worktree, plan.inspection.hardBlockers);
      }
    }
    if (input.deleteBranch) {
      const ineligible = plans.filter((plan) => !plan.inspection.branchDeletion.eligible);
      if (ineligible.length > 0) {
        throw new WaldError(
          `Cannot delete local branches:\n${ineligible
            .map((plan) => {
              const deletion = plan.inspection.branchDeletion;
              return `- ${plan.inspection.worktree.name}: ${deletion.eligible ? "not eligible" : deletion.reason}`;
            })
            .join("\n")}`,
        );
      }
    }
    for (const plan of plans) {
      if (plan.inspection.blockers.length > 0 && !input.force) {
        throw removalError(plan.inspection.worktree, [
          ...plan.inspection.blockers,
          "use --force only if this data can be discarded",
        ]);
      }
    }

    if (input.force) {
      const forcedPlans = plans.filter((plan) => plan.inspection.blockers.length > 0);
      if (forcedPlans.length > 0) {
        writeLine(context.output.stderr, "Warning: --force bypasses these removal safeguards:");
        for (const plan of forcedPlans) {
          const worktree = plan.inspection.worktree;
          writeLine(
            context.output.stderr,
            `  ${worktree.name} (${worktree.branch ?? "detached"}, ${worktree.path})`,
          );
          for (const blocker of plan.inspection.blockers) {
            writeLine(context.output.stderr, `    - ${blocker}`);
          }
        }
      }
    }

    let branchesToDelete: BranchDeletionPlan[] = [];
    let confirmedByBranchChoice = false;
    if (input.deleteBranch) {
      branchesToDelete = plans.flatMap((plan) => {
        const deletion = plan.inspection.branchDeletion;
        return deletion.eligible ? [deletion] : [];
      });
    } else if (!input.yes) {
      if (!isInteractiveTerminal()) {
        throw new WaldError("Non-interactive removal requires --yes.");
      }
      try {
        confirmedByBranchChoice = plans.some((plan) => plan.inspection.branchDeletion.eligible);
        branchesToDelete = await chooseBranchesToDelete(
          plans,
          previousBranchRefs,
          promptedForSelection ? "back" : "cancel",
        );
        previousBranchRefs = branchesToDelete.map((branch) => branch.branchRef);
      } catch (error) {
        if (!isPromptBackError(error) || !promptedForSelection) throw error;
        identifiers = [];
        continue;
      }
    }

    if (!input.yes && !confirmedByBranchChoice) {
      if (!isInteractiveTerminal()) {
        throw new WaldError("Non-interactive removal requires --yes.");
      }
      try {
        const branchAction =
          branchesToDelete.length === 0
            ? "Branches will be kept."
            : `Delete local ${branchesToDelete.length === 1 ? "branch" : "branches"}: ${branchesToDelete
                .map((branch) => style.branch(branch.branch))
                .join(", ")}.`;
        const accepted = await confirm(
          `Remove › Confirm · Remove ${plans.map((plan) => style.worktree(plan.inspection.worktree.name)).join(", ")}? ${branchAction}`,
          false,
          { navigation: promptedForSelection ? "back" : "cancel" },
        );
        if (!accepted) {
          writeLine(context.output.stdout, "Cancelled.");
          return;
        }
      } catch (error) {
        if (!isPromptBackError(error) || !promptedForSelection) throw error;
        identifiers = [];
        continue;
      }
    }

    for (const plan of plans) {
      await ensureTrusted(workspace, plan.project, context, { nonInteractive: input.json });
    }
    const selectedBranchRefs = new Set(branchesToDelete.map((branch) => branch.branchRef));
    const removedWorktrees: Array<{ name: string; branch: string | null; path: string }> = [];
    const deletedBranches: string[] = [];
    const keptBranches: string[] = [];
    for (const plan of plans) {
      const deletion = plan.inspection.branchDeletion;
      const deleteBranch = deletion.eligible && selectedBranchRefs.has(deletion.branchRef);
      await context.workflow.executeRemove(plan, {
        force: input.force,
        deleteBranch,
        output: context.output.stderr,
      });
      const removed = plan.inspection.worktree;
      removedWorktrees.push({ name: removed.name, branch: removed.branch, path: removed.path });
      if (deleteBranch && deletion.eligible) {
        deletedBranches.push(deletion.branch);
      } else if (removed.branch) {
        keptBranches.push(removed.branch);
      }
      if (!input.json) {
        await success(`Removed worktree ${style.worktree(removed.name)}`, context.output);
        if (deleteBranch && deletion.eligible) {
          await success(`Deleted local branch ${style.branch(deletion.branch)}`, context.output);
        } else if (removed.branch) {
          writeLine(
            context.output.stdout,
            `${style.label("Branch kept:")} ${style.branch(removed.branch)}`,
          );
        }
      }
    }
    if (input.json) {
      writeJson(context.output.stdout, {
        action: "removed",
        worktrees: removedWorktrees,
        deletedBranches,
        keptBranches,
      });
    }
    return;
  }
}

async function chooseBranchesToDelete(
  plans: RemovePlan[],
  initialBranchRefs: string[],
  navigation: "back" | "cancel",
): Promise<BranchDeletionPlan[]> {
  const candidates = plans.flatMap((plan) => {
    const deletion = plan.inspection.branchDeletion;
    return deletion.eligible ? [{ deletion, worktreeName: plan.inspection.worktree.name }] : [];
  });
  if (candidates.length === 0) {
    return [];
  }
  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (!candidate) return [];
    const selected = await confirm(
      `Remove › Branch · Delete ${candidate.deletion.mergedIntoDefault ? "local" : "unmerged local"} branch ${style.branch(candidate.deletion.branch)} too?`,
      initialBranchRefs.includes(candidate.deletion.branchRef),
      { navigation },
    );
    return selected ? [candidate.deletion] : [];
  }

  const selectedRefs = await selectManyValues(
    "Remove › Branches · Select local branches to delete:",
    candidates.map((candidate) => ({
      label: style.branch(candidate.deletion.branch),
      value: candidate.deletion.branchRef,
      description: candidate.deletion.mergedIntoDefault
        ? `worktree ${candidate.worktreeName}`
        : `worktree ${candidate.worktreeName}, unmerged`,
    })),
    { navigation, initialValues: initialBranchRefs },
  );
  return candidates
    .filter((candidate) => selectedRefs.includes(candidate.deletion.branchRef))
    .map((candidate) => candidate.deletion);
}
