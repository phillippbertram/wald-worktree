import type { Command } from "commander";
import { z } from "zod";
import { WaldError } from "../../domain/errors.js";
import type { Worktree } from "../../domain/types.js";
import { style } from "../../ui/style.js";
import {
  isInteractiveTerminal,
  isPromptBackError,
  promptText,
  selectValue,
  selectWorktree,
} from "../../ui/terminal.js";
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

export async function renameWorktree(
  input: RenameInput,
  context: CliContext,
): Promise<Worktree | null> {
  input = parseCliInput(renameInputSchema, input);
  const workspace = await context.workspaces.find();
  const plan =
    input.worktree && input.newName
      ? await context.worktrees.prepareMove(
          workspace,
          input.worktree,
          input.newName,
          undefined,
          input,
        )
      : await prepareGuidedRename(workspace, input, context);
  if (!plan) return null;
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
    return moved;
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
  return moved;
}

async function prepareGuidedRename(
  workspace: Awaited<ReturnType<CliContext["workspaces"]["find"]>>,
  input: RenameInput,
  context: CliContext,
) {
  if (!isInteractiveTerminal())
    throw new WaldError("Non-interactive rename requires a worktree and new name.");
  let initialPath: string | undefined;
  while (true) {
    const candidates = input.worktree
      ? []
      : await context.worktrees.listMoveCandidates(workspace, undefined, { keepBranch: true });
    if (!input.worktree && candidates.length === 0)
      throw new WaldError("No worktree can be renamed from the current location.");
    const worktree = input.worktree
      ? await context.worktrees.resolve(workspace, input.worktree)
      : await selectWorktree(candidates, { navigation: "cancel", initialValue: initialPath });
    if (!worktree) throw new WaldError("No worktree can be renamed from the current location.");
    initialPath = worktree.path;
    try {
      return await chooseRenameDetails(workspace, worktree, input, context);
    } catch (error) {
      if (!isPromptBackError(error) || input.worktree) throw error;
    }
  }
}

async function chooseRenameDetails(
  workspace: Awaited<ReturnType<CliContext["workspaces"]["find"]>>,
  worktree: Worktree,
  input: RenameInput,
  context: CliContext,
) {
  let mode = input.keepBranch ? "directory" : input.branch ? "custom" : "both";
  let name = input.newName ?? worktree.name;
  let branch = input.branch ?? worktree.branch ?? "";
  const chooseMode = !input.keepBranch && !input.branch && !input.newName;
  const canRenameBranch = (await context.worktrees.listMoveCandidates(workspace)).some(
    (item) => item.path === worktree.path,
  );
  if (chooseMode && !canRenameBranch) mode = "directory";
  const steps = [
    ...(chooseMode ? ["mode"] : []),
    ...(!input.newName ? ["name"] : []),
    ...(chooseMode ? ["branch"] : []),
    "review",
  ];
  let index = 0;
  while (index < steps.length) {
    const navigation = index === 0 && input.worktree ? "cancel" : "back";
    try {
      switch (steps[index]) {
        case "mode":
          mode = await selectValue(
            "Rename › Scope · What should change?",
            [
              ...(canRenameBranch ? [{ label: "Directory and local branch", value: "both" }] : []),
              { label: "Directory only, keep the branch", value: "directory" },
              ...(canRenameBranch
                ? [{ label: "Directory and a different local branch name", value: "custom" }]
                : []),
            ],
            { navigation, initialValue: mode },
          );
          break;
        case "name":
          name = await promptText(
            mode === "both"
              ? "Rename › Name · New directory and local branch name:"
              : "Rename › Name · New directory name:",
            name,
            {
              navigation,
              validate: (value) => (value ? undefined : "Enter a worktree directory name."),
              validateAsync: async (value) => {
                await context.worktrees.prepareMove(workspace, worktree.path, value, undefined, {
                  keepBranch: mode !== "both",
                });
              },
            },
          );
          break;
        case "branch":
          if (mode === "custom")
            branch = await promptText("Rename › Branch · New local branch name:", branch, {
              navigation: "back",
              validate: (value) => (value ? undefined : "Enter a branch name."),
              validateAsync: async (value) => {
                await context.worktrees.prepareMove(workspace, worktree.path, name, undefined, {
                  branch: value,
                });
              },
            });
          break;
        case "review": {
          const plan = await context.worktrees.prepareMove(
            workspace,
            worktree.path,
            name,
            undefined,
            { keepBranch: mode === "directory", branch: mode === "custom" ? branch : undefined },
          );
          writeLine(
            context.output.stdout,
            `${style.label("Directory:")} ${style.path(worktree.path)} → ${style.path(plan.target)}`,
          );
          writeLine(
            context.output.stdout,
            `${style.label("Branch:")} ${style.branch(worktree.branch ?? "detached")} → ${style.branch(plan.branchChange.after ?? "detached")}${plan.branchChange.renamed ? "" : " (kept)"}`,
          );
          writeLine(context.output.stdout, "Upstream tracking and remotes stay unchanged.");
          const action = await selectValue(
            "Rename › Review · Apply this rename?",
            [
              { label: "Rename worktree", value: "rename" },
              { label: "Cancel", value: "cancel" },
            ],
            { navigation: "back", initialValue: "rename" },
          );
          return action === "rename" ? plan : null;
        }
      }
      index += 1;
    } catch (error) {
      if (!isPromptBackError(error) || index === 0) throw error;
      index -= 1;
      if (steps[index] === "branch" && mode !== "custom") index -= 1;
    }
  }
  return null;
}
