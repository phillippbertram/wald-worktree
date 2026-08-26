import type { Command } from "commander";
import { isInteractiveTerminal, promptText, searchSelect } from "../ui/terminal.js";
import { showConfiguration } from "./commands/config.js";
import { createWorktree } from "./commands/create.js";
import { initializeWorkspace } from "./commands/init.js";
import { listWorktrees } from "./commands/list.js";
import { openSelectedWorktree } from "./commands/open.js";
import { removeWorktrees } from "./commands/remove.js";
import { runProjectTask } from "./commands/run.js";
import { setupWorktree } from "./commands/setup.js";
import type { CliContext } from "./context.js";
import { findWorkspaceOrNull, resolveWorktree } from "./helpers.js";
import { initializeProjectConfiguration } from "./project-config-wizard.js";

export async function runMainMenu(program: Command, context: CliContext): Promise<void> {
  if (!isInteractiveTerminal()) {
    context.output.stdout.write(program.helpInformation());
    return;
  }
  const workspace = await findWorkspaceOrNull(context);
  if (!workspace) {
    const action = await searchSelect("No wt workspace found. Choose an action:", [
      { label: "Set up current Git repository", value: "init" },
      { label: "Clone repository into a new workspace", value: "clone" },
      { label: "Exit", value: "exit" },
    ]);
    if (action === "init") await initializeWorkspace({}, context);
    if (action === "clone") {
      const repository = await promptText("Repository URL or local path:");
      if (!repository) return;
      const directory = await promptText("Workspace directory (optional):");
      await initializeWorkspace({ repository, directory: directory || undefined }, context);
    }
    return;
  }

  const current = await context.worktrees.current(workspace);
  const worktrees = await context.worktrees.list(workspace);
  const hasWorktrees = worktrees.length > 0;
  const actions = [
    { label: "Create worktree", value: "create" },
    { label: "List worktrees", value: "list" },
    ...(hasWorktrees
      ? [
          { label: "Open worktree", value: "open" },
          { label: "Run project task", value: "run" },
          { label: "Run worktree setup", value: "setup" },
          { label: "Execute command", value: "exec" },
          { label: "Remove worktree", value: "remove" },
          { label: "Create project configuration", value: "config-init" },
        ]
      : []),
    { label: "Configuration", value: "config" },
    { label: "Exit", value: "exit" },
  ];
  const action = await searchSelect("What do you want to do?", actions);

  switch (action) {
    case "create":
      await createWorktree({ cd: false, open: false, printPath: false }, context);
      break;
    case "list":
      await listWorktrees({ json: false }, context);
      break;
    case "remove":
      await removeWorktrees({ worktrees: [], force: false, yes: false }, context);
      break;
    case "open": {
      const selected = current ?? (await resolveWorktree(workspace, undefined, context.worktrees));
      await openSelectedWorktree(selected, undefined, context);
      break;
    }
    case "exec": {
      const selected = current ?? (await resolveWorktree(workspace, undefined, context.worktrees));
      const command = await promptText(`Command to run in ${selected.name}:`);
      if (command) await context.processes.runInteractiveShell(command, selected.path);
      break;
    }
    case "run":
      await runProjectTask({ worktree: current?.name }, context);
      break;
    case "setup":
      await setupWorktree({ worktree: current?.name }, context);
      break;
    case "config":
      await showConfiguration(context);
      break;
    case "config-init": {
      const selected = current ?? (await resolveWorktree(workspace, undefined, context.worktrees));
      await initializeProjectConfiguration(selected.path, { force: false, yes: false }, context);
      break;
    }
  }
}
