import { style } from "../ui/style.js";
import { isPromptBackError, selectValue } from "../ui/terminal.js";
import {
  initializeProjectConfigurationForWorktree,
  showConfiguration,
  trustConfiguration,
  untrustConfiguration,
} from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { executeCommand } from "./commands/exec.js";
import { runProjectHook } from "./commands/hook.js";
import { listWorktrees } from "./commands/list.js";
import { pruneWorktrees } from "./commands/prune.js";
import { removeWorktrees } from "./commands/remove.js";
import { showWorkspaceStatus } from "./commands/status.js";
import { uninitializeWorkspace } from "./commands/uninit.js";
import type { CliContext } from "./context.js";
import { resolveWorktree, writeLine } from "./helpers.js";
import { type MenuResult, reportMenuError, showMenuResult } from "./menu-result.js";

type MenuAction = {
  label: string;
  value: string;
  description?: string;
  run: () => Promise<unknown>;
};

export async function runSettingsMenu(context: CliContext): Promise<MenuResult> {
  return await runActionMenu(
    "Project settings",
    [
      {
        label: "Configure automation…",
        value: "configure",
        description: "Review detected setup, tasks, and the default editor.",
        run: async () => {
          const workspace = await context.workspaces.find();
          const worktree = await resolveWorktree(workspace, undefined, context.worktrees, {
            forcePrompt: true,
            navigation: "back",
          });
          await initializeProjectConfigurationForWorktree(
            {
              worktree: worktree.path,
              force: false,
              yes: false,
              scope: "workspace",
              fromProject: false,
            },
            context,
          );
        },
      },
      { label: "Review configuration", value: "config", run: () => showConfiguration(context) },
      {
        label: "Review and trust configuration",
        value: "trust",
        run: () => trustConfiguration(false, context),
      },
      {
        label: "Revoke configuration trust",
        value: "untrust",
        run: () => untrustConfiguration(false, context),
      },
      {
        label: "Shell integration instructions",
        value: "shell",
        run: async () => {
          writeLine(
            context.output.stdout,
            "Run the command for your shell to enable completion and worktree navigation:",
          );
          writeLine(context.output.stdout, style.command('zsh:  eval "$(wald completion zsh)"'));
          writeLine(context.output.stdout, style.command('bash: eval "$(wald completion bash)"'));
          writeLine(context.output.stdout, style.command("fish: wald completion fish | source"));
          writeLine(
            context.output.stdout,
            "For future sessions, add the matching command to your shell configuration.",
          );
        },
      },
    ],
    context,
  );
}

export async function runMaintenanceMenu(context: CliContext): Promise<MenuResult> {
  return await runActionMenu(
    "Maintenance & diagnostics",
    [
      {
        label: "Workspace status",
        value: "status",
        run: () => showWorkspaceStatus({ json: false }, context),
      },
      {
        label: "List all worktree paths",
        value: "list",
        run: () => listWorktrees({ json: false }, context),
      },
      {
        label: "Diagnose workspace",
        value: "doctor",
        run: () => runDoctor({ json: false, verbose: false }, context),
      },
      {
        label: "Remove multiple worktrees…",
        value: "remove",
        run: () =>
          removeWorktrees(
            { worktrees: [], force: false, deleteBranch: false, yes: false },
            context,
          ),
      },
      {
        label: "Prune stale worktree metadata…",
        value: "prune",
        run: () => pruneWorktrees({ apply: true, yes: false, json: false }, context),
      },
      { label: "Advanced automation…", value: "advanced", run: () => runAdvancedMenu(context) },
      {
        label: "Disconnect Wald workspace…",
        value: "uninit",
        run: async () => {
          return (await uninitializeWorkspace(
            { apply: true, force: false, yes: false, json: false },
            context,
          ))
            ? "exit"
            : undefined;
        },
      },
    ],
    context,
  );
}

async function runAdvancedMenu(context: CliContext): Promise<MenuResult> {
  const chooseTarget = async () =>
    resolveWorktree(await context.workspaces.find(), undefined, context.worktrees, {
      forcePrompt: true,
      navigation: "back",
    });
  return await runActionMenu(
    "Advanced automation",
    [
      {
        label: "Run lifecycle hook…",
        value: "hook",
        description: "Run configured lifecycle steps manually.",
        run: async () => runProjectHook({ worktree: (await chooseTarget()).path }, context),
      },
      {
        label: "Execute command…",
        value: "exec",
        description: "Run an ad-hoc command in a selected worktree.",
        run: async () =>
          executeCommand({ worktree: (await chooseTarget()).path, command: [] }, context),
      },
    ],
    context,
    "Back to maintenance",
  );
}

async function runActionMenu(
  title: string,
  actions: MenuAction[],
  context: CliContext,
  backLabel = "Back to main menu",
): Promise<MenuResult> {
  while (true) {
    let action: string;
    try {
      action = await selectValue(
        `${title} › Choose an action:`,
        [...actions, { label: backLabel, value: "back" }],
        { navigation: "back" },
      );
    } catch (error) {
      if (isPromptBackError(error)) return "back";
      throw error;
    }
    if (action === "back") return "back";
    try {
      const result = await actions.find((item) => item.value === action)?.run();
      if (result === "exit") return "exit";
      if (result === "back") continue;
    } catch (error) {
      if (isPromptBackError(error)) continue;
      reportMenuError(error, context);
    }
    if ((await showMenuResult(context, `Back to ${title.toLowerCase()}`)) === "exit") return "exit";
  }
}
