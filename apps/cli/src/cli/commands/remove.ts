import type { Command } from "commander";
import { z } from "zod";
import { WaldError } from "../../domain/errors.js";
import type { BranchDeletionPlan } from "../../services/worktree-service.js";
import type { RemovePlan } from "../../services/worktree-workflow-service.js";
import { style } from "../../ui/style.js";
import {
  isInteractiveTerminal,
  isPromptBackError,
  selectManyValues,
  selectManyWorktrees,
  selectValue,
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
  const branchState = { selectedRefs: [] as string[] };

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
    if (input.deleteBranch) {
      branchesToDelete = plans.flatMap((plan) => {
        const deletion = plan.inspection.branchDeletion;
        return deletion.eligible ? [deletion] : [];
      });
    }

    if (!input.yes) {
      if (!isInteractiveTerminal()) {
        throw new WaldError("Non-interactive removal requires --yes.");
      }
      try {
        const selected = await chooseRemovalAction(
          plans,
          input.deleteBranch,
          branchState,
          promptedForSelection ? "back" : "cancel",
          context,
        );
        if (selected === null) {
          writeLine(context.output.stdout, "Cancelled. Worktrees and branches were kept.");
          return;
        }
        branchesToDelete = selected;
        branchState.selectedRefs = selected.map((branch) => branch.branchRef);
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

async function chooseRemovalAction(
  plans: RemovePlan[],
  deleteBranches: boolean,
  branchState: { selectedRefs: string[] },
  navigation: "back" | "cancel",
  context: CliContext,
): Promise<BranchDeletionPlan[] | null> {
  const candidates = plans.flatMap((plan) => {
    const deletion = plan.inspection.branchDeletion;
    return deletion.eligible ? [{ deletion, worktreeName: plan.inspection.worktree.name }] : [];
  });
  writeLine(context.output.stdout, style.heading("Removal plan"));
  for (const { inspection } of plans) {
    const { worktree } = inspection;
    writeLine(
      context.output.stdout,
      `${style.label("Worktree:")} ${style.worktree(worktree.name)}`,
    );
    writeLine(
      context.output.stdout,
      `${style.label("Branch:")} ${style.branch(worktree.branch ?? "detached")}`,
    );
    writeLine(context.output.stdout, `${style.label("Path:")} ${style.path(worktree.path)}`);
  }
  const noun = plans.length === 1 ? "worktree" : `${plans.length} worktrees`;
  const unmerged = candidates.some(({ deletion }) => !deletion.mergedIntoDefault);
  while (true) {
    const action = await selectValue(
      "Remove › Action · What would you like to do?",
      [
        { label: "Cancel", value: "cancel", description: "Keep all worktrees and branches." },
        ...(!deleteBranches ? [{ label: `Remove ${noun}, keep branches`, value: "keep" }] : []),
        ...(candidates.length > 0
          ? [
              {
                label:
                  deleteBranches || plans.length === 1
                    ? `Remove ${noun} and ${unmerged ? "unmerged " : ""}local ${candidates.length === 1 ? "branch" : "branches"}`
                    : `Choose branches to delete with ${noun}…`,
                value: "delete",
                description: candidates
                  .map(({ deletion }) => style.branch(deletion.branch))
                  .join(", "),
              },
            ]
          : []),
      ],
      { navigation, initialValue: "cancel" },
    );
    if (action === "cancel") return null;
    if (action === "keep") return [];
    if (action !== "delete") return null;
    if (deleteBranches || plans.length === 1) return candidates.map(({ deletion }) => deletion);
    while (true) {
      try {
        branchState.selectedRefs = await selectManyValues(
          "Remove › Branches · Select local branches to delete:",
          candidates.map(({ deletion, worktreeName }) => ({
            label: style.branch(deletion.branch),
            value: deletion.branchRef,
            description: `worktree ${style.worktree(worktreeName)}${deletion.mergedIntoDefault ? "" : ", unmerged"}`,
          })),
          { navigation: "back", initialValues: branchState.selectedRefs },
        );
      } catch (error) {
        if (isPromptBackError(error)) break;
        throw error;
      }
      const selected = candidates.filter(({ deletion }) =>
        branchState.selectedRefs.includes(deletion.branchRef),
      );
      const branches = selected.map(({ deletion }) => style.branch(deletion.branch)).join(", ");
      try {
        const confirmed = await selectValue(
          "Remove › Confirm · Apply this removal?",
          [
            { label: "Cancel", value: "cancel" },
            {
              label: `Remove ${noun}, ${branches ? `delete branches: ${branches}` : "keep all branches"}`,
              value: "remove",
            },
          ],
          { navigation: "back", initialValue: "cancel" },
        );
        return confirmed === "remove" ? selected.map(({ deletion }) => deletion) : null;
      } catch (error) {
        if (!isPromptBackError(error)) throw error;
      }
    }
  }
}
