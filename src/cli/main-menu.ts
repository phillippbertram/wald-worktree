import type { Command } from "commander";
import { YggError } from "../domain/errors.js";
import { redactSensitiveText, sanitizeTerminalText } from "../infrastructure/safe-text.js";
import { style } from "../ui/style.js";
import { isInteractiveTerminal, isPromptBackError, selectValue } from "../ui/terminal.js";
import { renderWelcome } from "../ui/welcome.js";
import { initializeProjectConfigurationForWorktree, showConfiguration } from "./commands/config.js";
import { createWorktree } from "./commands/create.js";
import { executeCommand } from "./commands/exec.js";
import { handoffWorktree } from "./commands/handoff.js";
import { runProjectHook } from "./commands/hook.js";
import { initializeWorkspace } from "./commands/init.js";
import { listWorktrees } from "./commands/list.js";
import { openWorktree } from "./commands/open.js";
import { pruneWorktrees } from "./commands/prune.js";
import { removeWorktrees } from "./commands/remove.js";
import { renameWorktree } from "./commands/rename.js";
import { runProjectTask } from "./commands/run.js";
import { setupWorktree } from "./commands/setup.js";
import { showWorkspaceStatus } from "./commands/status.js";
import { uninitializeWorkspace } from "./commands/uninit.js";
import type { CliContext } from "./context.js";
import { findWorkspaceOrNull, writeLine } from "./helpers.js";

export async function runMainMenu(program: Command, context: CliContext): Promise<void> {
  if (!isInteractiveTerminal()) {
    context.output.stdout.write(program.helpInformation());
    return;
  }
  while (true) {
    const workspace = await findWorkspaceOrNull(context);
    if (!workspace) {
      context.output.stdout.write(renderWelcome(null));
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
    context.output.stdout.write(
      renderWelcome({
        workspaceRoot: workspace.root,
        current,
        worktreeCount: worktrees.length,
      }),
    );
    const hasWorktrees = worktrees.length > 0;
    const canRename = (await context.worktrees.listMoveCandidates(workspace)).length > 0;
    const actions = [
      {
        label: "🌱 Create worktree",
        value: "create",
        description: "Create an isolated checkout for a branch.",
        group: "Common",
      },
      ...(current
        ? [
            {
              label: "Hand off current work",
              value: "handoff",
              description: "Copy local changes into a new worktree and keep this source unchanged.",
              group: "Common",
            },
          ]
        : []),
      ...(hasWorktrees
        ? [
            {
              label: "🌳 Open worktree",
              value: "open",
              description: "Open a checkout in an editor or agent.",
              group: "Common",
            },
          ]
        : []),
      {
        label: "🌿 List worktrees",
        value: "list",
        description: "Show all checkouts and their current state.",
        group: "Common",
      },
      {
        label: "Workspace status",
        value: "status",
        description: "Show workspace, tracking, trust, and worktree health.",
        group: "Common",
      },
      ...(hasWorktrees
        ? [
            {
              label: "Set up worktree",
              value: "setup",
              description: "Re-run post-create setup for a checkout.",
              group: "Project automation",
            },
            {
              label: "Run project task",
              value: "run",
              description: "Run a task from effective project configuration.",
              group: "Project automation",
            },
            {
              label: "Run lifecycle hook",
              value: "hook",
              description: "Run a configured hook without changing Git state.",
              group: "Project automation",
            },
            {
              label: "Execute command",
              value: "exec",
              description: "Run a shell command in a selected checkout.",
              group: "Project automation",
            },
            {
              label: "Create project configuration",
              value: "config-init",
              description: "Create or update workspace-local project configuration.",
              group: "Project automation",
            },
            {
              label: "Rename worktree",
              value: "rename",
              description: "Rename a checkout directory while keeping its branch.",
              group: "Maintenance",
            },
            {
              label: "🍂 Remove worktree",
              value: "remove",
              description: "Safely remove checkouts with optional merged-branch cleanup.",
              group: "Maintenance",
            },
          ].filter((action) => action.value !== "rename" || canRename)
        : []),
      {
        label: "🍂 Prune stale worktree metadata",
        value: "prune",
        description: "Clean registrations for missing checkouts.",
        group: "Maintenance",
      },
      {
        label: "Configuration",
        value: "config",
        description: "Show workspace and project configuration.",
        group: "Maintenance",
      },
      {
        label: "Disconnect Ygg workspace",
        value: "uninit",
        description: "Remove Ygg metadata while keeping the Git repository.",
        group: "Maintenance",
      },
      {
        label: "Exit",
        value: "exit",
        description: "Close the interactive Ygg session.",
        group: "Session",
      },
    ];

    let action: string;
    try {
      action = await selectValue("🌳 What do you want to do?", actions, {
        navigation: "exit",
      });
    } catch (error) {
      if (isPromptBackError(error)) return;
      throw error;
    }
    if (action === "exit") return;

    try {
      switch (action) {
        case "create":
          await createWorktree({ carry: false, cd: false, open: false, printPath: false }, context);
          break;
        case "handoff":
          await handoffWorktree({ cd: false, open: false, printPath: false }, context);
          break;
        case "list":
          await listWorktrees({ json: false }, context);
          break;
        case "status":
          await showWorkspaceStatus({ json: false }, context);
          break;
        case "prune":
          await pruneWorktrees({ apply: true, yes: false, json: false }, context);
          break;
        case "uninit": {
          const removed = await uninitializeWorkspace(
            { apply: true, force: false, yes: false, json: false },
            context,
          );
          if (removed) return;
          break;
        }
        case "remove":
          await removeWorktrees(
            { worktrees: [], force: false, deleteBranch: false, yes: false },
            context,
          );
          break;
        case "rename":
          await renameWorktree({}, context);
          break;
        case "open": {
          await openWorktree(undefined, undefined, context);
          break;
        }
        case "exec": {
          await executeCommand({ worktree: undefined, command: [] }, context);
          break;
        }
        case "run":
          await runProjectTask({}, context);
          break;
        case "setup":
          await setupWorktree({}, context);
          break;
        case "hook":
          await runProjectHook({}, context);
          break;
        case "config":
          await showConfiguration(context);
          break;
        case "config-init": {
          await initializeProjectConfigurationForWorktree(
            {
              worktree: undefined,
              force: false,
              yes: false,
              scope: "workspace",
              fromProject: false,
            },
            context,
          );
          break;
        }
      }
    } catch (error) {
      if (isPromptBackError(error)) continue;
      if (error instanceof YggError && error.exitCode !== 130) {
        writeLine(
          context.output.stderr,
          `${style.danger("Error:")} ${sanitizeTerminalText(redactSensitiveText(error.message), { multiline: true })}`,
        );
      } else {
        throw error;
      }
    }

    try {
      await selectValue(
        "What next?",
        [
          {
            label: "Exit",
            value: "exit",
            description: "Close the interactive Ygg session.",
          },
        ],
        { navigation: "back" },
      );
      return;
    } catch (error) {
      if (isPromptBackError(error)) continue;
      throw error;
    }
  }
}
