import type { Command } from "commander";
import type { Worktree } from "../domain/types.js";
import { isInteractiveTerminal, isPromptBackError, selectValue } from "../ui/terminal.js";
import { renderWelcome, renderWorkspaceContext } from "../ui/welcome.js";
import { createWorktree } from "./commands/create.js";
import { handoffWorktree } from "./commands/handoff.js";
import { initializeWorkspace } from "./commands/init.js";
import { runProjectTask } from "./commands/run.js";
import type { CliContext } from "./context.js";
import { findWorkspaceOrNull, resolveWorktree } from "./helpers.js";
import { reportMenuError, showMenuResult } from "./menu-result.js";
import { runMaintenanceMenu, runSettingsMenu } from "./workspace-menus.js";
import { browseWorktrees } from "./worktree-menu.js";

export async function runMainMenu(program: Command, context: CliContext): Promise<void> {
  if (!isInteractiveTerminal()) {
    context.output.stdout.write(program.helpInformation());
    return;
  }
  let welcomed = false;
  while (true) {
    const workspace = await findWorkspaceOrNull(context);
    if (!workspace) {
      if (!welcomed) context.output.stdout.write(renderWelcome(null));
      welcomed = true;
      try {
        const initialized = await initializeWorkspace({}, context);
        if (!initialized) return;
        process.chdir(initialized.root);
      } catch (error) {
        if (isPromptBackError(error)) return;
        throw error;
      }
      continue;
    }
    const current = await context.worktrees.current(workspace);
    const worktrees = await context.worktrees.list(workspace);
    const summary = { workspaceRoot: workspace.root, current, worktreeCount: worktrees.length };
    context.output.stdout.write(
      welcomed ? renderWorkspaceContext(summary) : renderWelcome(summary),
    );
    welcomed = true;
    let action: string;
    try {
      action = await selectValue(
        "What would you like to do?",
        [
          {
            label: "Create worktree",
            value: "create",
            description: "Create an isolated checkout for a branch.",
          },
          {
            label: "Worktrees…",
            value: "worktrees",
            description: "Select a checkout to open, rename, or remove.",
          },
          ...(current
            ? [
                {
                  label: "Copy current changes to a new worktree…",
                  value: "handoff",
                  description: "Keep the source unchanged.",
                },
              ]
            : []),
          ...(worktrees.length > 0 ? [{ label: "Project tasks…", value: "tasks" }] : []),
          {
            label: "Project settings…",
            value: "settings",
            description: "Automation, configuration trust, and shell integration.",
          },
          { label: "Maintenance & diagnostics…", value: "maintenance" },
          { label: "Exit", value: "exit" },
        ],
        { navigation: "exit" },
      );
    } catch (error) {
      if (isPromptBackError(error)) return;
      throw error;
    }
    if (action === "exit") return;
    let created: Worktree | null | undefined;
    try {
      switch (action) {
        case "create":
          created = await createWorktree(
            { carry: false, cd: false, open: false, printPath: false },
            context,
          );
          break;
        case "handoff":
          created = await handoffWorktree({ cd: false, open: false, printPath: false }, context);
          break;
        case "worktrees":
          if ((await browseWorktrees(workspace, context)) === "exit") return;
          continue;
        case "tasks": {
          const worktree = await resolveWorktree(workspace, undefined, context.worktrees, {
            forcePrompt: true,
            navigation: "back",
          });
          await runProjectTask({ worktree: worktree.path }, context);
          break;
        }
        case "settings":
          if ((await runSettingsMenu(context)) === "exit") return;
          continue;
        case "maintenance":
          if ((await runMaintenanceMenu(context)) === "exit") return;
          continue;
      }
    } catch (error) {
      if (isPromptBackError(error)) continue;
      reportMenuError(error, context);
    }
    if ((await showMenuResult(context, "Back to main menu", created)) === "exit") return;
  }
}
