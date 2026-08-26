import { Command } from "commander";
import { WtError } from "../domain/errors.js";
import type {
  EnvironmentFileStatus,
  EnvironmentSyncResult,
  Workspace,
  Worktree,
} from "../domain/types.js";
import { GitClient } from "../infrastructure/git-client.js";
import { EnvironmentService } from "../services/environment-service.js";
import {
  type AdoptionInspection,
  type AdoptionOptions,
  WorkspaceService,
} from "../services/workspace-service.js";
import { WorktreeService } from "../services/worktree-service.js";
import {
  confirm,
  isInteractiveTerminal,
  printCandidateTable,
  printEnvironmentTable,
  printKeyValueTable,
  printStatus,
  printWorktreeTable,
  promptText,
  runTask,
  selectEnvironmentFiles,
  selectValue,
  selectWorktree,
} from "../ui/terminal.js";

type Output = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

type InitOptions = {
  adopt?: string | boolean;
  worktreesDir?: string;
  remote?: string | false;
  defaultBranch?: string;
  yes?: boolean;
};

export function createProgram(
  output: Output = { stdout: process.stdout, stderr: process.stderr },
): Command {
  const git = new GitClient();
  const workspaceService = new WorkspaceService(git);
  const worktreeService = new WorktreeService(git);
  const environmentService = new EnvironmentService(git);

  const program = new Command()
    .name("wt")
    .description("A small, safe workspace manager for Git worktrees.")
    .version("0.1.0")
    .showSuggestionAfterError()
    .showHelpAfterError();

  program.configureOutput({
    writeOut: (text) => output.stdout.write(text),
    writeErr: (text) => output.stderr.write(text),
  });

  program
    .command("init")
    .description("Create a workspace or adopt an existing Git repository")
    .argument("[repository]", "Git remote URL or local repository path")
    .argument("[directory]", "Workspace directory")
    .option("--adopt [path]", "Adopt an existing repository; defaults to the current directory")
    .option("--worktrees-dir <path>", "Directory for newly created worktrees")
    .option("--remote <name>", "Remote used for fetching and branch resolution")
    .option("--no-remote", "Adopt as a local-only repository")
    .option("--default-branch <branch>", "Default branch used for new branches and merge checks")
    .option("--yes", "Accept detected adoption settings without prompting")
    .action(
      async (
        repository: string | undefined,
        directory: string | undefined,
        options: InitOptions,
      ) => {
        if (!repository) {
          await initializeAdoptedWorkspace(workspaceService, options, output);
          return;
        }
        if (hasAdoptionOptions(options)) {
          throw new WtError(
            "Adoption options cannot be combined with clone mode. Use wt init --adopt [path].",
          );
        }
        const workspace = await runTask("Initializing workspace", () =>
          workspaceService.initialize(repository, directory),
        );
        await success(`Initialized workspace at ${workspace.root}`, output);
        writeLine(
          output.stdout,
          `Next: cd ${shellQuote(workspace.root)} && wt add ${workspace.config.defaultBranch}`,
        );
      },
    );

  program
    .command("add")
    .description("Create a worktree for an existing or new branch")
    .argument("<branch>", "Branch to check out or create")
    .option("--from <commit-ish>", "Base for a new branch")
    .option("--name <directory>", "Override the worktree directory name")
    .option("--no-fetch", "Do not fetch the configured remote before resolving the branch")
    .option("--no-env", "Do not synchronize shared environment files")
    .action(
      async (
        branch: string,
        options: { from?: string; name?: string; fetch: boolean; env: boolean },
      ) => {
        const workspace = await workspaceService.find();
        const worktree = await runTask("Creating worktree", () =>
          worktreeService.add(workspace, {
            branch,
            from: options.from,
            name: options.name,
            fetch: options.fetch,
          }),
        );

        if (options.env) {
          const syncResult = await runTask("Synchronizing environment files", () =>
            environmentService.sync(workspace, worktree),
          );
          await printSyncWarnings(syncResult, output);
        }

        await success(`Created ${worktree.name} at ${worktree.path}`, output);
        writeLine(output.stdout, `cd ${shellQuote(worktree.path)}`);
      },
    );

  program
    .command("list")
    .alias("ls")
    .description("List managed worktrees")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const workspace = await workspaceService.find();
      const worktrees = await runTask("Reading worktrees", () => worktreeService.list(workspace));
      if (options.json) {
        writeJson(output.stdout, worktrees);
      } else if (isInteractiveTerminal()) {
        await printWorktreeTable(worktrees);
      } else {
        printPlainWorktrees(worktrees, output.stdout);
      }
    });

  program
    .command("remove")
    .alias("rm")
    .description("Safely remove a managed worktree")
    .argument("<worktree>", "Worktree name, branch, or path")
    .option("--force", "Bypass dirty, unmerged, and lock safeguards")
    .action(async (identifier: string, options: { force?: boolean }) => {
      const workspace = await workspaceService.find();
      const inspection = await worktreeService.inspectRemoval(workspace, identifier);

      if (inspection.hardBlockers.length > 0) {
        throw new WtError(
          `Refusing to remove ${inspection.worktree.name}:\n${inspection.hardBlockers.map((item) => `- ${item}`).join("\n")}`,
        );
      }

      if (inspection.blockers.length > 0 && !options.force) {
        throw new WtError(
          `Refusing to remove ${inspection.worktree.name}:\n${inspection.blockers.map((item) => `- ${item}`).join("\n")}\nUse --force only if this data can be discarded.`,
        );
      }

      if (!options.force) {
        if (!isInteractiveTerminal()) {
          throw new WtError("Removing a worktree without a TTY requires --force.");
        }
        const accepted = await confirm(
          `Remove ${inspection.worktree.name}? The branch and shared environment files will be kept.`,
        );
        if (!accepted) {
          writeLine(output.stdout, "Cancelled.");
          return;
        }
      }

      await runTask("Removing worktree", () =>
        worktreeService.remove(workspace, inspection.worktree, Boolean(options.force)),
      );
      await success(`Removed ${inspection.worktree.name}`, output);
    });

  const env = program.command("env").description("Manage shared environment files");

  env
    .command("status")
    .description("Show shared environment-link status")
    .argument("[worktree]", "Worktree name, branch, or path")
    .option("--json", "Emit machine-readable JSON")
    .action(async (identifier: string | undefined, options: { json?: boolean }) => {
      const workspace = await workspaceService.find();
      const worktrees = await resolveMany(workspace, identifier, worktreeService);
      const rows = await environmentRows(workspace, worktrees, environmentService);

      if (options.json) {
        writeJson(
          output.stdout,
          rows.map(({ worktree, status }) => ({ worktree: worktree.name, ...status })),
        );
      } else if (isInteractiveTerminal()) {
        await printEnvironmentTable(rows);
      } else {
        for (const { worktree, status } of rows) {
          writeLine(output.stdout, `${worktree.name}\t${status.path}\t${status.state}`);
        }
      }
    });

  env
    .command("sync")
    .description("Create missing shared environment links")
    .argument("[worktree]", "Worktree name, branch, or path")
    .option("--repair", "Replace incorrect symlinks; regular files are still preserved")
    .action(async (identifier: string | undefined, options: { repair?: boolean }) => {
      const workspace = await workspaceService.find();
      const worktrees = await resolveMany(workspace, identifier, worktreeService);
      for (const worktree of worktrees) {
        const result = await runTask(`Synchronizing ${worktree.name}`, () =>
          environmentService.sync(workspace, worktree, options),
        );
        await printSyncResult(result, output);
      }
    });

  env
    .command("import")
    .description("Import ignored environment files and replace them with shared links")
    .argument("[worktree]", "Worktree name, branch, or path")
    .option("--yes", "Import all safe candidates without interactive confirmation")
    .action(async (identifier: string | undefined, options: { yes?: boolean }) => {
      const workspace = await workspaceService.find();
      const worktree = await resolveOneForImport(workspace, identifier, worktreeService);
      const candidates = await environmentService.discoverImportCandidates(workspace, worktree);

      if (candidates.length === 0) {
        await info(`No ignored environment files found in ${worktree.name}`, output);
        return;
      }

      const safeCandidates = candidates.filter(
        (candidate) => candidate.state === "new" || candidate.state === "same",
      );
      if (safeCandidates.length === 0) {
        for (const conflict of candidates) {
          writeLine(output.stderr, `Conflict preserved: ${conflict.path}`);
        }
        return;
      }

      let selected = safeCandidates;
      if (!options.yes) {
        if (!isInteractiveTerminal()) {
          throw new WtError("Non-interactive environment imports require a worktree and --yes.");
        }
        await printCandidateTable(candidates);
        const paths = await selectEnvironmentFiles(candidates);
        selected = candidates.filter((candidate) => paths.includes(candidate.path));
        if (selected.length === 0) {
          writeLine(output.stdout, "Cancelled: no files selected.");
          return;
        }
        const accepted = await confirm(
          `Import ${selected.length} file(s) and replace the originals with symlinks?`,
        );
        if (!accepted) {
          writeLine(output.stdout, "Cancelled.");
          return;
        }
      }

      const result = await runTask("Importing environment files", () =>
        environmentService.importFiles(workspace, worktree, selected),
      );
      const discoveredConflicts = candidates.filter((candidate) => candidate.state === "conflict");
      await success(
        `Imported ${result.imported.length} and linked ${result.linked.length} environment file(s) in ${worktree.name}`,
        output,
      );
      for (const conflict of discoveredConflicts) {
        writeLine(output.stderr, `Conflict preserved: ${conflict.path}`);
      }
    });

  return program;
}

async function resolveMany(
  workspace: Workspace,
  identifier: string | undefined,
  worktrees: WorktreeService,
): Promise<Worktree[]> {
  if (identifier) {
    return [await worktrees.resolve(workspace, identifier)];
  }
  const current = await worktrees.current(workspace);
  if (current) {
    return [current];
  }
  return await worktrees.list(workspace);
}

async function resolveOneForImport(
  workspace: Workspace,
  identifier: string | undefined,
  worktrees: WorktreeService,
): Promise<Worktree> {
  if (identifier) {
    return await worktrees.resolve(workspace, identifier);
  }
  const current = await worktrees.current(workspace);
  if (current) {
    return current;
  }

  const all = await worktrees.list(workspace);
  if (all.length === 0) {
    throw new WtError("The workspace has no worktrees. Create one with wt add first.");
  }
  if (all.length === 1) {
    return all[0] as Worktree;
  }
  if (!isInteractiveTerminal()) {
    throw new WtError("Specify a worktree when importing without an interactive terminal.");
  }
  const selected = await selectWorktree(all);
  if (!selected) {
    throw new WtError("No worktree selected.");
  }
  return selected;
}

async function environmentRows(
  workspace: Workspace,
  worktrees: Worktree[],
  environments: EnvironmentService,
): Promise<Array<{ worktree: Worktree; status: EnvironmentFileStatus }>> {
  const nested = await Promise.all(
    worktrees.map(async (worktree) =>
      (await environments.status(workspace, worktree)).map((status) => ({ worktree, status })),
    ),
  );
  return nested.flat();
}

async function printSyncResult(result: EnvironmentSyncResult, output: Output): Promise<void> {
  const changed = result.created.length + result.repaired.length;
  const message = `${result.worktree.name}: ${changed} link(s) updated, ${result.linked.length} already correct`;
  if (isInteractiveTerminal()) {
    await printStatus(result.conflicts.length > 0 ? "warning" : "success", message);
  } else {
    writeLine(output.stdout, message);
  }
  await printSyncWarnings(result, output);
}

async function printSyncWarnings(result: EnvironmentSyncResult, output: Output): Promise<void> {
  for (const conflict of result.conflicts) {
    writeLine(output.stderr, `Environment conflict preserved: ${conflict.target}`);
  }
}

function printPlainWorktrees(worktrees: Worktree[], stream: NodeJS.WritableStream): void {
  writeLine(stream, "NAME\tBRANCH\tROLE\tSTATUS\tPATH");
  for (const worktree of worktrees) {
    writeLine(
      stream,
      `${worktree.name}\t${worktree.branch ?? "detached"}\t${worktree.role}\t${worktree.state}\t${worktree.path}`,
    );
  }
}

async function initializeAdoptedWorkspace(
  workspaces: WorkspaceService,
  options: InitOptions,
  output: Output,
): Promise<void> {
  const explicitAdoption = options.adopt !== undefined;
  if (!isInteractiveTerminal() && (!explicitAdoption || !options.yes)) {
    throw new WtError("Non-interactive adoption requires --adopt and --yes.");
  }

  const source = typeof options.adopt === "string" ? options.adopt : ".";
  const requested: AdoptionOptions = {
    worktreeDir: options.worktreesDir,
    remote: options.remote === false ? null : options.remote,
    defaultBranch: options.defaultBranch,
  };

  let inspection: AdoptionInspection;
  try {
    inspection = await runTask("Inspecting repository", () =>
      workspaces.inspectAdoption(source, requested),
    );
  } catch (error) {
    if (!explicitAdoption && error instanceof WtError && error.message.startsWith("Not a Git")) {
      throw new WtError(
        "No Git repository detected. Use wt init <repository> [directory] to create a new workspace.",
      );
    }
    throw error;
  }

  if (inspection.existingWorkspace) {
    await success(`Workspace already initialized at ${inspection.existingWorkspace.root}`, output);
    return;
  }

  if (inspection.remoteSelectionRequired) {
    if (!isInteractiveTerminal() || options.yes) {
      throw new WtError("Multiple remotes found. Select one with --remote or use --no-remote.");
    }
    const selected = await selectValue("Select the remote wt should use:", [
      ...inspection.remotes.map((remote) => ({ label: remote, value: remote })),
      { label: "No remote (local only)", value: "__none__" },
    ]);
    if (!selected) {
      throw new WtError("No remote selected.");
    }
    requested.remote = selected === "__none__" ? null : selected;
    inspection = await workspaces.inspectAdoption(source, requested);
  }

  if (!inspection.defaultBranch) {
    if (!isInteractiveTerminal() || options.yes) {
      throw new WtError("Could not determine the default branch. Use --default-branch.");
    }

    const customValue = "__custom__";
    const selected =
      inspection.defaultBranchCandidates.length > 0
        ? await selectValue("Select the default branch:", [
            ...inspection.defaultBranchCandidates.map((branch) => ({
              label: branch,
              value: branch,
            })),
            { label: "Enter another branch", value: customValue },
          ])
        : customValue;
    if (!selected) {
      throw new WtError("No default branch selected.");
    }
    requested.defaultBranch =
      selected === customValue ? await promptText("Default branch:") : selected;
    if (!requested.defaultBranch) {
      throw new WtError("Default branch cannot be empty.");
    }
    inspection = await workspaces.inspectAdoption(source, requested);
  }

  if (inspection.worktreeDirSelectionRequired) {
    if (!isInteractiveTerminal() || options.yes) {
      throw new WtError("Could not select a safe worktree directory. Use --worktrees-dir.");
    }
    requested.worktreeDir = await promptText(
      "Directory for new worktrees:",
      inspection.worktreeDir,
    );
    if (!requested.worktreeDir) {
      throw new WtError("Worktree directory cannot be empty.");
    }
    inspection = await workspaces.inspectAdoption(source, requested);
  }

  if (isInteractiveTerminal() && !options.yes) {
    await printKeyValueTable(adoptionSummary(inspection));
    const accepted = await confirm(
      "Adopt this repository? Existing Git configuration and worktree files will be preserved.",
    );
    if (!accepted) {
      writeLine(output.stdout, "Cancelled.");
      return;
    }
  }

  const workspace = await runTask("Adopting repository", () => workspaces.adopt(inspection));
  await success(`Adopted repository at ${workspace.root}`, output);
  writeLine(output.stdout, `Worktrees: ${workspace.worktreeDir}`);
  writeLine(output.stdout, "Next: wt list");
  if (workspace.primaryWorktree) {
    writeLine(output.stdout, "Optional: wt env import");
  }
}

function hasAdoptionOptions(options: InitOptions): boolean {
  return (
    options.adopt !== undefined ||
    options.worktreesDir !== undefined ||
    options.remote !== undefined ||
    options.defaultBranch !== undefined ||
    options.yes !== undefined
  );
}

function adoptionSummary(inspection: AdoptionInspection): Array<[string, string]> {
  return [
    ["Repository", inspection.primaryWorktree ?? inspection.gitDir],
    ["Git directory", inspection.gitDir],
    ["Repository type", inspection.bare ? "bare" : "working tree"],
    [
      "Existing worktrees",
      String(inspection.worktrees.filter((worktree) => !worktree.bare).length),
    ],
    ["New worktrees", inspection.worktreeDir],
    ["Remote", inspection.remoteName ?? "none (local only)"],
    ["Default branch", inspection.defaultBranch ?? "unresolved"],
  ];
}

async function success(message: string, output: Output): Promise<void> {
  if (isInteractiveTerminal()) {
    await printStatus("success", message);
  } else {
    writeLine(output.stdout, message);
  }
}

async function info(message: string, output: Output): Promise<void> {
  if (isInteractiveTerminal()) {
    await printStatus("info", message);
  } else {
    writeLine(output.stdout, message);
  }
}

function writeJson(stream: NodeJS.WritableStream, value: unknown): void {
  writeLine(stream, JSON.stringify(value, null, 2));
}

function writeLine(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
