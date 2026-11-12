import type { Workspace, Worktree } from "../domain/types.js";
import { style } from "../ui/style.js";
import { isPromptBackError, selectValue, selectWorktree } from "../ui/terminal.js";
import { openWorktree } from "./commands/open.js";
import { removeWorktrees } from "./commands/remove.js";
import { renameWorktree } from "./commands/rename.js";
import { runProjectTask } from "./commands/run.js";
import { setupWorktree } from "./commands/setup.js";
import type { CliContext } from "./context.js";
import { writeLine } from "./helpers.js";
import { type MenuResult, reportMenuError, showMenuResult, showNavigation } from "./menu-result.js";

export async function browseWorktrees(
  workspace: Workspace,
  context: CliContext,
): Promise<MenuResult> {
  let initialPath = (await context.worktrees.current(workspace))?.path;
  while (true) {
    const worktrees = await context.worktrees.list(workspace);
    if (worktrees.length === 0) {
      writeLine(context.output.stdout, "No worktrees yet. Choose Create worktree to get started.");
      return await showMenuResult(context);
    }
    let selected: Worktree | null;
    try {
      selected = await selectWorktree(worktrees, { navigation: "back", initialValue: initialPath });
    } catch (error) {
      if (isPromptBackError(error)) return "back";
      throw error;
    }
    if (!selected) return "back";
    initialPath = selected.path;
    if ((await worktreeActions(workspace, selected, context)) === "exit") return "exit";
  }
}

async function worktreeActions(
  workspace: Workspace,
  selected: Worktree,
  context: CliContext,
): Promise<MenuResult> {
  while (true) {
    const worktree = (await context.worktrees.list(workspace)).find(
      (item) => item.path === selected.path,
    );
    if (!worktree) return "back";
    const current = await context.worktrees.current(workspace);
    const canRename = (
      await context.worktrees.listMoveCandidates(workspace, undefined, { keepBranch: true })
    ).some((item) => item.path === worktree.path);
    const canRemove = worktree.role !== "primary" && worktree.path !== current?.path;
    writeLine(
      context.output.stdout,
      `${style.worktree(worktree.name)} · ${style.branch(worktree.branch ?? "detached")} · ${style.state(worktree.state, worktree.state)}`,
    );
    writeLine(context.output.stdout, style.path(worktree.path));
    let action: string;
    try {
      action = await selectValue(
        "Worktree › What would you like to do?",
        [
          { label: "Open in editor or agent", value: "open" },
          { label: "Show navigation command", value: "navigate" },
          { label: "Run project task…", value: "run" },
          {
            label: "Run setup again",
            value: "setup",
            description: "Re-run the configured post-create steps.",
          },
          ...(canRename ? [{ label: "Rename…", value: "rename" }] : []),
          ...(canRemove ? [{ label: "Remove…", value: "remove" }] : []),
          { label: "Back to worktrees", value: "back" },
        ],
        { navigation: "back" },
      );
    } catch (error) {
      if (isPromptBackError(error)) return "back";
      throw error;
    }
    if (action === "back") return "back";
    try {
      switch (action) {
        case "open":
          await openWorktree(worktree.path, undefined, context);
          break;
        case "navigate":
          showNavigation(worktree, context);
          break;
        case "run":
          await runProjectTask({ worktree: worktree.path }, context);
          break;
        case "setup":
          await setupWorktree({ worktree: worktree.path }, context);
          break;
        case "rename": {
          const moved = await renameWorktree({ worktree: worktree.path }, context);
          if (moved) selected = moved;
          break;
        }
        case "remove":
          await removeWorktrees(
            { worktrees: [worktree.path], force: false, deleteBranch: false, yes: false },
            context,
          );
          break;
      }
    } catch (error) {
      if (isPromptBackError(error)) continue;
      reportMenuError(error, context);
    }
    if ((await showMenuResult(context, "Back to worktree actions")) === "exit") return "exit";
  }
}
