import type { Command } from "commander";
import { z } from "zod";
import { WtError } from "../../domain/errors.js";
import type { AdoptionInspection, AdoptionOptions } from "../../services/workspace-service.js";
import {
  confirm,
  isInteractiveTerminal,
  printKeyValueTable,
  promptText,
  runTask,
  searchSelect,
  selectValue,
} from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { shellQuote, success, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";
import { initializeProjectConfiguration } from "../project-config-wizard.js";

const initInputSchema = z
  .object({
    repository: nonEmptyCliString.optional(),
    directory: nonEmptyCliString.optional(),
    adopt: z.union([nonEmptyCliString, z.literal(true)]).optional(),
    worktreesDir: nonEmptyCliString.optional(),
    remote: z.union([nonEmptyCliString, z.literal(false)]).optional(),
    defaultBranch: nonEmptyCliString.optional(),
    config: z.boolean().optional(),
    yes: z.boolean().optional(),
  })
  .strict();

export type InitInput = z.output<typeof initInputSchema>;

export function registerInitCommand(program: Command, context: CliContext): void {
  program
    .command("init")
    .description("Create a managed workspace or adopt an existing Git repository")
    .argument("[repository]", "Git remote URL or local repository path")
    .argument("[directory]", "Workspace directory")
    .option("--adopt [path]", "Adopt an existing repository; defaults to the current directory")
    .option("--worktrees-dir <path>", "Directory for newly created worktrees")
    .option("--remote <name>", "Remote used for fetching and branch resolution")
    .option("--no-remote", "Adopt as a local-only repository")
    .option("--default-branch <branch>", "Default branch used for creation and merge checks")
    .option("--config", "Create a detected .wt.yml after adopting a working repository")
    .option("--yes", "Accept detected adoption settings without prompting")
    .action(async (repository: unknown, directory: unknown, options: unknown) => {
      const input = parseCliInput(initInputSchema, {
        repository,
        directory,
        ...(options as object),
      });
      await initializeWorkspace(input, context);
    });
}

export async function initializeWorkspace(input: InitInput, context: CliContext): Promise<void> {
  if (!input.repository) {
    await initializeAdoptedWorkspace(input, context);
    return;
  }
  if (hasAdoptionOptions(input)) {
    throw new WtError("Adoption options cannot be combined with clone mode. Use wt init --adopt.");
  }
  const workspace = await runTask("Initializing workspace", () =>
    context.workspaces.initialize(input.repository as string, input.directory),
  );
  await success(`Initialized workspace at ${workspace.root}`, context.output);
  writeLine(context.output.stdout, `Next: wt create ${shellQuote(workspace.config.defaultBranch)}`);
  writeLine(
    context.output.stdout,
    `Then: wt config init ${shellQuote(workspace.config.defaultBranch)}`,
  );
}

async function initializeAdoptedWorkspace(input: InitInput, context: CliContext): Promise<void> {
  const explicit = input.adopt !== undefined;
  if (!isInteractiveTerminal() && (!explicit || !input.yes)) {
    throw new WtError("Non-interactive adoption requires --adopt and --yes.");
  }
  const source = typeof input.adopt === "string" ? input.adopt : ".";
  const requested: AdoptionOptions = {
    worktreeDir: input.worktreesDir,
    remote: input.remote === false ? null : input.remote,
    defaultBranch: input.defaultBranch,
  };
  let inspection = await inspectAdoption(source, requested, explicit, context);
  if (inspection.existingWorkspace) {
    await success(
      `Workspace already initialized at ${inspection.existingWorkspace.root}`,
      context.output,
    );
    return;
  }
  if (inspection.remoteSelectionRequired) {
    if (!isInteractiveTerminal() || input.yes) {
      throw new WtError("Multiple remotes found. Select one with --remote or --no-remote.");
    }
    const selected = await selectValue("Select the remote wt should use:", [
      ...inspection.remotes.map((remote) => ({ label: remote, value: remote })),
      { label: "No remote (local only)", value: "__none__" },
    ]);
    if (!selected) throw new WtError("No remote selected.");
    requested.remote = selected === "__none__" ? null : selected;
    inspection = await context.workspaces.inspectAdoption(source, requested);
  }
  if (!inspection.defaultBranch) {
    if (!isInteractiveTerminal() || input.yes) {
      throw new WtError("Could not determine the default branch. Use --default-branch.");
    }
    const custom = "__custom__";
    const selected = await searchSelect("Select the default branch:", [
      ...inspection.defaultBranchCandidates.map((branch) => ({ label: branch, value: branch })),
      { label: "Enter another branch", value: custom },
    ]);
    if (!selected) throw new WtError("No default branch selected.");
    requested.defaultBranch = selected === custom ? await promptText("Default branch:") : selected;
    inspection = await context.workspaces.inspectAdoption(source, requested);
  }
  if (inspection.worktreeDirSelectionRequired) {
    if (!isInteractiveTerminal() || input.yes) {
      throw new WtError("Could not select a safe worktree directory. Use --worktrees-dir.");
    }
    requested.worktreeDir = await promptText(
      "Directory for new worktrees:",
      inspection.worktreeDir,
    );
    inspection = await context.workspaces.inspectAdoption(source, requested);
  }
  if (isInteractiveTerminal() && !input.yes) {
    await printKeyValueTable(adoptionSummary(inspection));
    if (!(await confirm("Adopt this repository without changing existing Git configuration?"))) {
      writeLine(context.output.stdout, "Cancelled.");
      return;
    }
  }
  const workspace = await runTask("Adopting repository", () =>
    context.workspaces.adopt(inspection),
  );
  await success(`Adopted repository at ${workspace.root}`, context.output);
  writeLine(context.output.stdout, `Worktrees: ${workspace.worktreeDir}`);
  await maybeInitializeProjectConfig(workspace.primaryWorktree, input, context);
}

async function maybeInitializeProjectConfig(
  primaryWorktree: string | null,
  input: InitInput,
  context: CliContext,
): Promise<void> {
  if (!primaryWorktree) {
    if (input.config) {
      throw new WtError(
        "Cannot create .wt.yml while adopting a bare repository without a worktree. Create a worktree, then run wt config init.",
      );
    }
    return;
  }
  if (await context.configs.readProjectConfig(primaryWorktree)) return;

  const requested = Boolean(input.config);
  const shouldCreate =
    requested ||
    (isInteractiveTerminal() &&
      !input.yes &&
      (await confirm("Create an initial .wt.yml now?", true)));
  if (!shouldCreate) {
    writeLine(context.output.stdout, "Optional: wt config init");
    return;
  }
  await initializeProjectConfiguration(
    primaryWorktree,
    { force: false, yes: Boolean(input.yes) },
    context,
  );
}

async function inspectAdoption(
  source: string,
  requested: AdoptionOptions,
  explicit: boolean,
  context: CliContext,
): Promise<AdoptionInspection> {
  try {
    return await runTask("Inspecting repository", () =>
      context.workspaces.inspectAdoption(source, requested),
    );
  } catch (error) {
    if (!explicit && error instanceof WtError && error.message.startsWith("Not a Git")) {
      throw new WtError("No Git repository detected. Use wt init <repository> [directory].");
    }
    throw error;
  }
}

function hasAdoptionOptions(input: InitInput): boolean {
  return (
    input.adopt !== undefined ||
    input.worktreesDir !== undefined ||
    input.remote !== undefined ||
    input.defaultBranch !== undefined ||
    input.config === true ||
    input.yes === true
  );
}

function adoptionSummary(inspection: AdoptionInspection): Array<[string, string]> {
  return [
    ["Repository", inspection.primaryWorktree ?? inspection.gitDir],
    ["Repository type", inspection.bare ? "bare" : "working tree"],
    ["Existing worktrees", String(inspection.worktrees.filter((item) => !item.bare).length)],
    ["New worktrees", inspection.worktreeDir],
    ["Remote", inspection.remoteName ?? "none"],
    ["Default branch", inspection.defaultBranch ?? "unresolved"],
  ];
}
