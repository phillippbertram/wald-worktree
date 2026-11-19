import type { RemovePlan } from "./worktree-workflow-service.js";

export function previewRemoval(
  plans: RemovePlan[],
  deleteBranches: boolean | ReadonlySet<string>,
  force: boolean,
) {
  const worktrees = plans.map(({ inspection, trusted }) => {
    const { worktree, branchDeletion } = inspection;
    const requested =
      typeof deleteBranches === "boolean"
        ? deleteBranches
        : branchDeletion.eligible && deleteBranches.has(branchDeletion.branchRef);
    const branchAction = requested
      ? branchDeletion.eligible
        ? "delete"
        : "blocked"
      : worktree.branch
        ? "keep"
        : "none";
    const hardBlockers = [...inspection.hardBlockers];
    if (requested && !branchDeletion.eligible) hardBlockers.push(branchDeletion.reason);
    return {
      name: worktree.name,
      path: worktree.path,
      branch: worktree.branch,
      branchAction,
      branchReason: branchDeletion.eligible ? null : branchDeletion.reason,
      forceReasons: inspection.blockers,
      hardBlockers,
      requiresTrust: !trusted,
    };
  });
  const blocked = worktrees.some(
    (item) =>
      item.hardBlockers.length > 0 ||
      item.requiresTrust ||
      (!force && item.forceReasons.length > 0),
  );
  return { action: "preview" as const, force, blocked, worktrees };
}

export type RemovalPreview = ReturnType<typeof previewRemoval>;
