import type { Command } from "commander";
import { z } from "zod";
import { type RemovalEffects, toErrorMessage, WaldError } from "../../domain/errors.js";
import { previewRemoval, type RemovalPreview } from "../../services/removal-preview.js";
import type { RemovePlan } from "../../services/worktree-workflow-service.js";
import { style } from "../../ui/style.js";
import {
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
    dryRun: z.boolean().default(false),
    force: z.boolean().default(false),
    deleteBranch: z.boolean().default(false),
    yes: z.boolean().default(false),
    json: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.json && (input.worktrees.length === 0 || (!input.yes && !input.dryRun))) {
      context.addIssue({
        code: "custom",
        path: ["json"],
        message: "JSON removal requires worktree names and either --dry-run or --yes.",
      });
    }
  });

export type RemoveInput = Omit<z.output<typeof removeInputSchema>, "json" | "dryRun"> & {
  json?: boolean;
  dryRun?: boolean;
};

export function registerRemoveCommand(program: Command, context: CliContext): void {
  program
    .command("remove")
    .description("Safely remove worktrees and optionally their local branches")
    .argument("[worktrees...]", "Worktree names, branches, or paths")
    .option("--dry-run", "Inspect removal without running hooks or changing worktrees or branches")
    .option("--force", "Bypass dirty, unmerged, and lock safeguards")
    .option(
      "--delete-branch",
      "Delete each removed worktree's eligible local branch; unmerged branches require force confirmation or --force",
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
  const canPrompt = !input.yes && !input.json && context.canPrompt();

  while (true) {
    if (promptedForSelection) {
      if (!canPrompt) {
        throw new WaldError("Specify the worktree names to inspect or remove.");
      }
      const listed = await context.worktrees.list(workspace);
      const current = await context.worktrees.currentFromList(listed);
      const candidates = listed.filter(
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
      identifiers = previousSelectionPaths;
    }
    if (identifiers.length === 0) {
      writeLine(context.output.stdout, "Cancelled: no worktrees selected.");
      return;
    }

    const plans = await context.workflow.planRemovals(workspace, identifiers);
    const preview = previewRemoval(plans, input.deleteBranch, input.force);
    if (input.dryRun) {
      if (input.json) writeJson(context.output.stdout, preview);
      else showPreview(preview, context);
      return;
    }
    for (const item of preview.worktrees) {
      if (item.hardBlockers.length) throw removalError(item, item.hardBlockers);
      if (item.forceReasons.length && !input.force && !canPrompt) {
        throw removalError(item, [
          ...item.forceReasons,
          "use --force only if this data can be discarded",
        ]);
      }
    }

    let decision = preview;
    if (!input.yes) {
      if (!canPrompt) throw new WaldError("Non-interactive removal requires --yes.");
      try {
        const selected = await chooseRemovalAction(
          plans,
          input,
          branchState,
          promptedForSelection ? "back" : "cancel",
          context,
        );
        if (!selected) {
          writeLine(context.output.stdout, "Cancelled. Worktrees and branches were kept.");
          return;
        }
        decision = selected;
      } catch (error) {
        if (!isPromptBackError(error) || !promptedForSelection) throw error;
        continue;
      }
    } else if (input.force) {
      showRemovalSafeguards(plans, "Warning: --force bypasses these removal safeguards:", context);
    }

    for (const plan of plans) {
      await ensureTrusted(workspace, plan.project, context, { nonInteractive: input.json });
    }
    const deletePaths = new Set(
      decision.worktrees.filter((item) => item.branchAction === "delete").map((item) => item.path),
    );
    const targets = decision.worktrees.map(({ name, branch, path }) => ({ name, branch, path }));
    const removedWorktrees: RemovalEffects["removedWorktrees"] = [];
    const deletedBranches: string[] = [];
    const keptBranches: string[] = [];
    for (const [index, plan] of plans.entries()) {
      const deletion = plan.inspection.branchDeletion;
      const deleteBranch = deletePaths.has(plan.inspection.worktree.path);
      try {
        await context.workflow.executeRemove(plan, {
          force: input.force || (decision.force && plan.inspection.blockers.length > 0),
          deleteBranch,
          output: context.output.stderr,
        });
      } catch (error) {
        if (plans.length === 1) throw error;
        const partial = error instanceof WaldError ? error.effects : undefined;
        const pending = targets.slice(index + 1);
        const completedNames = removedWorktrees.map((item) => item.name).join(", ") || "none";
        const pendingNames = pending.map((item) => item.name).join(", ") || "none";
        throw new WaldError(
          `${toErrorMessage(error)}\nBatch stopped at ${plan.inspection.worktree.name}. Completed: ${completedNames}. Pending: ${pendingNames}.`,
          {
            cause: error,
            exitCode: error instanceof WaldError ? error.exitCode : 1,
            effects: {
              completedWorktrees: removedWorktrees,
              failedWorktree: targets[index],
              pendingWorktrees: pending,
              removedWorktrees: [...removedWorktrees, ...(partial?.removedWorktrees ?? [])],
              deletedBranches: [...deletedBranches, ...(partial?.deletedBranches ?? [])],
              keptBranches: [...keptBranches, ...(partial?.keptBranches ?? [])],
            },
          },
        );
      }
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
  input: RemoveInput,
  branchState: { selectedRefs: string[] },
  navigation: "back" | "cancel",
  context: CliContext,
): Promise<RemovalPreview | null> {
  const candidates = plans.flatMap(({ inspection }) =>
    inspection.branchDeletion.eligible ? [inspection.branchDeletion] : [],
  );
  const needsForce = plans.some(({ inspection }) => inspection.blockers.length > 0);
  const verb = needsForce ? "Force removal of" : "Remove";
  const noun = plans.length === 1 ? "1 worktree" : `${plans.length} worktrees`;
  const confirmPlan = async (preview: RemovalPreview, back: "back" | "cancel") => {
    showPreview(preview, context);
    const deletes = preview.worktrees.filter((item) => item.branchAction === "delete").length;
    const consequence = deletes
      ? `delete ${deletes} local ${deletes === 1 ? "branch" : "branches"}`
      : "keep local branches";
    const action = await selectValue(
      "Remove › Confirm · Apply this removal?",
      [
        { label: "Cancel", value: "cancel" },
        { label: `${verb} ${noun}, ${consequence}`, value: needsForce ? "force" : "remove" },
      ],
      { navigation: back, initialValue: "cancel" },
    );
    return action === "cancel" ? null : preview;
  };
  if (input.deleteBranch || candidates.length === 0) {
    return await confirmPlan(
      previewRemoval(plans, input.deleteBranch, input.force || needsForce),
      navigation,
    );
  }
  const allRefs = new Set(candidates.map((branch) => branch.branchRef));
  const previewFor = (refs: ReadonlySet<string>) =>
    previewRemoval(plans, refs, input.force || needsForce);
  while (true) {
    for (const { inspection } of plans) {
      const { worktree } = inspection;
      writeLine(
        context.output.stdout,
        `${worktree.name} (${worktree.branch ?? "detached"}, ${worktree.path})`,
      );
    }
    showRemovalSafeguards(plans, "Removal safeguards:", context);
    const single = plans.length === 1;
    const action = await selectValue(
      "Remove › Action · What would you like to do?",
      [
        { label: "Cancel", value: "cancel" },
        {
          label: single ? `${verb} ${noun}, keep local branch` : "Keep all local branches",
          value: "keep",
        },
        {
          label: single
            ? `${verb} ${noun} and delete local branch`
            : "Delete all eligible local branches",
          value: "delete",
          description: candidates
            .map((branch) => branch.branch + (branch.mergedIntoDefault ? "" : " (unmerged)"))
            .join(", "),
        },
        ...(!single ? [{ label: "Choose local branches to delete…", value: "choose" }] : []),
      ],
      { navigation, initialValue: "cancel" },
    );
    if (action === "cancel") return null;
    if (action === "choose") {
      while (true) {
        try {
          branchState.selectedRefs = await selectManyValues(
            "Remove › Branches · Select local branches to delete:",
            candidates.map((branch) => ({
              label: branch.branch,
              value: branch.branchRef,
              description: branch.mergedIntoDefault ? undefined : "unmerged",
            })),
            {
              navigation: "back",
              initialValues: branchState.selectedRefs.filter((ref) => allRefs.has(ref)),
            },
          );
        } catch (error) {
          if (isPromptBackError(error)) break;
          throw error;
        }
        try {
          return await confirmPlan(previewFor(new Set(branchState.selectedRefs)), "back");
        } catch (error) {
          if (!isPromptBackError(error)) throw error;
        }
      }
      continue;
    }
    const preview = previewFor(action === "delete" ? allRefs : new Set());
    if (single) return preview;
    try {
      return await confirmPlan(preview, "back");
    } catch (error) {
      if (!isPromptBackError(error)) throw error;
    }
  }
}

function showRemovalSafeguards(plans: RemovePlan[], heading: string, context: CliContext): void {
  const blocked = plans.filter((plan) => plan.inspection.blockers.length > 0);
  if (blocked.length === 0) return;
  writeLine(context.output.stderr, heading);
  for (const { inspection } of blocked) {
    const { worktree } = inspection;
    writeLine(
      context.output.stderr,
      `  ${worktree.name} (${worktree.branch ?? "detached"}, ${worktree.path})`,
    );
    for (const blocker of inspection.blockers) {
      writeLine(context.output.stderr, `    - ${blocker}`);
    }
  }
}

function showPreview(preview: RemovalPreview, context: CliContext): void {
  writeLine(context.output.stdout, style.heading("Removal plan"));
  if (preview.blocked)
    writeLine(context.output.stdout, "Blocked with the current options or project trust.");
  for (const item of preview.worktrees) {
    writeLine(context.output.stdout, `Worktree: ${item.name} (${item.path})`);
    const reason = item.branchReason ? ` (${item.branchReason})` : "";
    if (item.branchAction === "delete")
      writeLine(context.output.stdout, `Delete local branch: ${item.branch}`);
    else if (item.branchAction === "blocked")
      writeLine(
        context.output.stdout,
        `Cannot delete local branch: ${item.branch ?? "detached"}${reason}`,
      );
    else if (item.branch)
      writeLine(context.output.stdout, `Keep local branch: ${item.branch}${reason}`);
    else writeLine(context.output.stdout, `No local branch deleted: ${item.branchReason}`);
    for (const blocker of item.hardBlockers)
      writeLine(context.output.stdout, `  Blocked: ${blocker}`);
    for (const blocker of item.forceReasons)
      writeLine(context.output.stdout, `  Requires force: ${blocker}`);
    if (item.requiresTrust)
      writeLine(context.output.stdout, "  Requires project configuration trust.");
  }
}
