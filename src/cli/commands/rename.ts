import type { Command } from "commander";
import { z } from "zod";
import { YggError } from "../../domain/errors.js";
import { style } from "../../ui/style.js";
import { isInteractiveTerminal, promptText, selectWorktree } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { success, writeJson, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const renameInputSchema = z
  .object({
    worktree: nonEmptyCliString.optional(),
    newName: nonEmptyCliString.optional(),
    json: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
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
    .description("Rename a linked worktree directory without renaming its branch")
    .argument("[worktree]", "Worktree name, branch, or path")
    .argument("[new-name]", "New worktree directory name")
    .option("--json", "Emit machine-readable JSON without prompting")
    .addHelpText("after", "\nExamples:\n  ygg rename feature-payment payment-ui\n  ygg rename\n")
    .action(async (worktree: unknown, newName: unknown, options: unknown) => {
      await renameWorktree(
        parseCliInput(renameInputSchema, { worktree, newName, ...(options as object) }),
        context,
      );
    });
}

export async function renameWorktree(input: RenameInput, context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  let identifier = input.worktree;
  let newName = input.newName;

  if (!identifier || !newName) {
    if (!isInteractiveTerminal()) {
      throw new YggError("Non-interactive rename requires a worktree and new name.");
    }
    if (!identifier) {
      const candidates = await context.worktrees.listMoveCandidates(workspace);
      if (candidates.length === 0) {
        throw new YggError("No worktree can be renamed from the current location.");
      }
      const selected = await selectWorktree(candidates, { navigation: "cancel" });
      if (!selected) throw new YggError("No worktree selected.");
      identifier = selected.name;
    }
    if (!newName) {
      newName = await promptText("Rename › New name · Worktree directory name:", undefined, {
        navigation: "cancel",
      });
      if (!newName) throw new YggError("Worktree directory name cannot be empty.");
    }
  }

  const plan = await context.worktrees.prepareMove(workspace, identifier, newName);
  const moved = await context.worktrees.move(workspace, plan);
  if (input.json) {
    writeJson(context.output.stdout, {
      action: "renamed",
      before: { name: plan.worktree.name, path: plan.worktree.path },
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
  writeLine(
    context.output.stdout,
    `${style.label("Branch kept:")} ${style.branch(moved.branch ?? "detached")}`,
  );
  writeLine(context.output.stdout, `${style.label("Path:")} ${style.path(moved.path)}`);
}
