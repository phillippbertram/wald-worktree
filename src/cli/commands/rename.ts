import type { Command } from "commander";
import { z } from "zod";
import { WaldError } from "../../domain/errors.js";
import { style } from "../../ui/style.js";
import { isInteractiveTerminal, promptText, selectWorktree } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { success, writeJson, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const renameInputSchema = z
  .object({
    worktree: nonEmptyCliString.optional(),
    newName: nonEmptyCliString.optional(),
    branch: nonEmptyCliString.optional(),
    keepBranch: z.boolean().optional(),
    json: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.branch !== undefined && input.keepBranch) {
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "Cannot be combined with --keep-branch.",
      });
    }
    if (input.json && (!input.worktree || !input.newName)) {
      context.addIssue({
        code: "custom",
        path: ["json"],
        message: "JSON mode requires a worktree and new name.",
      });
    }
  });

export type RenameInput = Omit<z.output<typeof renameInputSchema>, "json"> & { json?: boolean };

export function registerRenameCommand(program: Command, context: CliContext): void {
  program
    .command("rename")
    .description("Rename a linked worktree directory and its local branch")
    .argument("[worktree]", "Worktree name, branch, or path")
    .argument("[new-name]", "New directory and local branch name")
    .option("--branch <new-branch>", "Use a different new local branch name")
    .option("--keep-branch", "Rename only the directory, keeping the current branch")
    .option("--json", "Emit machine-readable JSON without prompting")
    .addHelpText(
      "after",
      "\n--branch and --keep-branch cannot be combined.\nThe default branch and detached worktrees require --keep-branch.\nUpstream tracking is kept; remotes are never changed.\n\nExamples:\n  wald rename feature-payment payment-review\n  wald rename feature-payment payment-review --branch feature/payment-review\n  wald rename feature-payment payment-review --keep-branch\n  wald rename\n",
    )
    .action(async (worktree: unknown, newName: unknown, options: unknown) => {
      await renameWorktree(
        parseCliInput(renameInputSchema, { worktree, newName, ...(options as object) }),
        context,
      );
    });
}

export async function renameWorktree(input: RenameInput, context: CliContext): Promise<void> {
  input = parseCliInput(renameInputSchema, input);
  const workspace = await context.workspaces.find();
  let identifier = input.worktree;
  let newName = input.newName;

  if (!identifier || !newName) {
    if (!isInteractiveTerminal()) {
      throw new WaldError("Non-interactive rename requires a worktree and new name.");
    }
    if (!identifier) {
      const candidates = await context.worktrees.listMoveCandidates(workspace, undefined, input);
      if (candidates.length === 0) {
        throw new WaldError("No worktree can be renamed from the current location.");
      }
      const selected = await selectWorktree(candidates, { navigation: "cancel" });
      if (!selected) throw new WaldError("No worktree selected.");
      identifier = selected.name;
    }
    if (!newName) {
      newName = await promptText(
        input.keepBranch || input.branch
          ? "Rename › New name · Worktree directory name:"
          : "Rename › New name · Directory and local branch name:",
        undefined,
        {
          navigation: "cancel",
        },
      );
      if (!newName) throw new WaldError("Worktree directory name cannot be empty.");
    }
  }

  const plan = await context.worktrees.prepareMove(workspace, identifier, newName, undefined, {
    branch: input.branch,
    keepBranch: input.keepBranch,
  });
  const moved = await context.worktrees.move(workspace, plan);
  if (input.json) {
    writeJson(context.output.stdout, {
      action: "renamed",
      before: { name: plan.worktree.name, path: plan.worktree.path, branch: plan.worktree.branch },
      branchChange: plan.branchChange,
      worktree: {
        name: moved.name,
        branch: moved.branch,
        path: moved.path,
        role: moved.role,
        state: moved.state,
        head: moved.head,
      },
    });
    return;
  }
  await success(
    `Renamed ${style.worktree(plan.worktree.name)} to ${style.worktree(moved.name)}`,
    context.output,
  );
  if (plan.branchChange.renamed) {
    writeLine(
      context.output.stdout,
      `${style.label("Branch renamed:")} ${style.branch(plan.branchChange.before ?? "detached")} → ${style.branch(moved.branch ?? "detached")}`,
    );
    if (plan.branchChange.upstream) {
      writeLine(
        context.output.stdout,
        `${style.label("Upstream kept:")} ${style.branch(plan.branchChange.upstream)}`,
      );
    }
  } else {
    writeLine(
      context.output.stdout,
      `${style.label("Branch kept:")} ${style.branch(moved.branch ?? "detached")}`,
    );
  }
  writeLine(context.output.stdout, `${style.label("Path:")} ${style.path(moved.path)}`);
}
