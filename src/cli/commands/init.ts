import path from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { YggError } from "../../domain/errors.js";
import { humanizeRepositoryName } from "../../infrastructure/path-utils.js";
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
import { ensureTrusted, shellQuote, success, writeLine } from "../helpers.js";
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
    .description("Keep an existing checkout or create a standalone workspace root")
    .argument("[repository]", "Remote URL or local repository to clone when provided")
    .argument("[directory]", "Workspace directory")
    .option("--adopt [path]", "Keep an existing checkout; defaults to the current directory")
    .option(
      "--worktrees-dir <path>",
      "Worktree directory; inside the workspace root for cloned repositories",
    )
    .option("--remote <name>", "Remote used for fetching and branch resolution")
    .option("--no-remote", "Use no remote (local-only repository)")
    .option("--default-branch <branch>", "Default branch used for creation and merge checks")
    .option("--config", "Create a detected .ygg.yml in the retained checkout")
    .option("--yes", "Accept detected settings without prompting")
    .addHelpText(
      "after",
      "\nExamples:\n  cd ~/dev/project && ygg init\n  ygg init git@github.com:example/project.git ~/dev/project\n  ygg init git@github.com:example/project.git ~/dev/project --worktrees-dir worktrees\n  ygg init --adopt . --yes --config\n",
    )
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
    if (isInteractiveTerminal() && !hasExplicitAdoptionInput(input)) {
      await initializeGuidedWorkspace(context);
      return;
    }
    await initializeAdoptedWorkspace(input, context);
    return;
  }
  if (hasAdoptionOptions(input)) {
    throw new YggError(
      "Existing-checkout options cannot be combined with clone mode. Use ygg init --adopt.",
    );
  }
  const workspace = await runTask("Initializing workspace", () =>
    context.workspaces.initialize(input.repository as string, input.directory, process.cwd(), {
      worktreeDir: input.worktreesDir,
    }),
  );
  await success(`Initialized workspace at ${workspace.root}`, context.output);
  writeLine(context.output.stdout, `Next: cd ${shellQuote(workspace.root)}`);
  writeLine(
    context.output.stdout,
    `Then: ygg create ${shellQuote(workspace.config.defaultBranch)} --cd`,
  );
}

async function initializeGuidedWorkspace(context: CliContext): Promise<void> {
  const current = await inspectExistingRepositoryOrNull(".", context);
  if (!current) {
    await initializeGuidedSource(context);
    return;
  }
  if (current.existingWorkspace) {
    await context.workspaces.ensureSharedDirectory(current.existingWorkspace);
    await success(
      `Workspace already initialized at ${current.existingWorkspace.root}`,
      context.output,
    );
    const worktrees = await context.worktrees.list(current.existingWorkspace);
    const preferred =
      (await context.worktrees.current(current.existingWorkspace)) ??
      worktrees.find(
        (worktree) => worktree.branch === current.existingWorkspace?.config.defaultBranch,
      ) ??
      worktrees[0] ??
      null;
    await maybeInitializeProjectConfig(preferred?.path ?? null, {}, context);
    return;
  }

  const keepRecommended = current.modifiedWorktrees.length > 0 || current.stashCount > 0;
  const choice = await selectValue("How should ygg organize this repository?", [
    ...(keepRecommended
      ? [
          {
            label: "Keep this checkout (recommended)",
            value: "keep",
            description: "Add worktrees elsewhere without moving local files.",
          },
          {
            label: "Create a new workspace root",
            value: "copy",
            description: "Copy committed Git history into the recommended standalone layout.",
          },
        ]
      : [
          {
            label: "Create a new workspace root (recommended)",
            value: "copy",
            description: "Copy committed Git history into one standalone workspace directory.",
          },
          {
            label: "Keep this checkout",
            value: "keep",
            description: "Leave this checkout here and add worktrees elsewhere.",
          },
        ]),
  ]);
  if (!choice) {
    writeLine(context.output.stdout, "Cancelled.");
    return;
  }
  if (choice === "keep") {
    await initializeAdoptedWorkspace({}, context);
    return;
  }
  if (choice === "copy") {
    await initializeCopiedWorkspace(current, context);
  }
}

async function initializeGuidedSource(context: CliContext): Promise<void> {
  const repository = await promptText("Remote URL or local repository path:");
  if (!repository) {
    writeLine(context.output.stdout, "Cancelled.");
    return;
  }
  const local = await inspectExistingRepositoryOrNull(repository, context);
  if (local) {
    await initializeCopiedWorkspace(local, context);
    return;
  }

  const directory = await promptText("Workspace root:", humanizeRepositoryName(repository));
  if (!directory) {
    writeLine(context.output.stdout, "Cancelled.");
    return;
  }
  const worktreeDir = await chooseManagedWorktreeDirectory();
  const workspace = await runTask("Initializing workspace", () =>
    context.workspaces.initialize(repository, directory, process.cwd(), { worktreeDir }),
  );
  await success(`Initialized workspace at ${workspace.root}`, context.output);
  await completeNewWorkspace(workspace, context);
}

async function initializeCopiedWorkspace(
  initialInspection: AdoptionInspection,
  context: CliContext,
): Promise<void> {
  const requested: AdoptionOptions = {};
  const inspection = await resolveRepositorySettings(
    initialInspection.source,
    requested,
    initialInspection,
    false,
    context,
  );
  const sourceRoot = inspection.primaryWorktree ?? path.dirname(inspection.gitDir);
  const repositoryName = path.basename(sourceRoot).replace(/\.git$/u, "") || "repository";
  const suggestedRoot = path.join(path.dirname(sourceRoot), `${repositoryName}-workspace`);
  const directory = await promptText("New workspace root:", suggestedRoot);
  if (!directory) {
    writeLine(context.output.stdout, "Cancelled.");
    return;
  }
  const worktreeDir = await chooseManagedWorktreeDirectory();
  const resolvedRoot = path.resolve(directory);
  const resolvedWorktrees = path.resolve(resolvedRoot, worktreeDir);
  await printKeyValueTable([
    ["Source repository", sourceRoot],
    ["New workspace root", resolvedRoot],
    ["New worktrees", resolvedWorktrees],
    ["Remote", inspection.remoteName ?? "none (local only)"],
    ["Default branch", inspection.defaultBranch ?? "unresolved"],
    ["Working-tree and ignored files", "not copied — source remains unchanged"],
    [
      "Modified worktrees",
      inspection.modifiedWorktrees.length > 0
        ? inspection.modifiedWorktrees.join(", ")
        : "none detected",
    ],
    [
      "Detached worktrees",
      inspection.detachedWorktrees.length > 0
        ? `${inspection.detachedWorktrees.length} — commits need a branch to be copied reliably`
        : "none",
    ],
    [
      "Stashes copied",
      inspection.stashCount > 0 ? `no — ${inspection.stashCount} remain in source` : "none",
    ],
  ]);
  if (!(await confirm("Create this standalone workspace from committed Git history?", true))) {
    writeLine(context.output.stdout, "Cancelled.");
    return;
  }
  const workspace = await runTask("Creating standalone workspace", () =>
    context.workspaces.initializeFromExisting(inspection, resolvedRoot, process.cwd(), {
      worktreeDir,
    }),
  );
  await success(`Initialized workspace at ${workspace.root}`, context.output);
  writeLine(context.output.stdout, `Original checkout kept at ${sourceRoot}`);
  await completeNewWorkspace(workspace, context);
}

async function chooseManagedWorktreeDirectory(): Promise<string> {
  const custom = "__custom__";
  const selected = await selectValue("Where should worktrees be created?", [
    {
      label: "Directly in the workspace root (recommended)",
      value: ".",
      description: "Creates main and feature directories beside repo.git.",
    },
    {
      label: "In a worktrees subdirectory",
      value: "worktrees",
      description: "Groups all checkouts below <workspace>/worktrees.",
    },
    { label: "Choose another subdirectory", value: custom },
  ]);
  if (!selected) throw new YggError("No worktree directory selected.");
  if (selected !== custom) return selected;
  const value = await promptText("Worktree directory inside the workspace root:", "worktrees");
  if (!value) throw new YggError("Worktree directory cannot be empty.");
  return value;
}

async function completeNewWorkspace(
  workspace: Awaited<ReturnType<CliContext["workspaces"]["find"]>>,
  context: CliContext,
): Promise<void> {
  if (!(await confirm(`Create the ${workspace.config.defaultBranch} worktree now?`, true))) {
    writeLine(context.output.stdout, `Next: cd ${shellQuote(workspace.root)}`);
    writeLine(
      context.output.stdout,
      `Then: ygg create ${shellQuote(workspace.config.defaultBranch)} --cd`,
    );
    return;
  }
  const plan = await runTask("Preparing default worktree", () =>
    context.workflow.planCreate(workspace, {
      branch: workspace.config.defaultBranch,
      fetch: false,
    }),
  );
  await ensureTrusted(workspace, plan.project, context);
  const created = await context.workflow.executeCreate(plan, { output: context.output.stderr });
  await success(`Created ${created.name} at ${created.path}`, context.output);
  await maybeInitializeProjectConfig(created.path, {}, context);
  writeLine(context.output.stdout, `Next: cd ${shellQuote(created.path)}`);
  writeLine(context.output.stdout, "Then create a feature worktree with: ygg create <branch> --cd");
}

async function initializeAdoptedWorkspace(input: InitInput, context: CliContext): Promise<void> {
  const explicit = input.adopt !== undefined;
  if (!isInteractiveTerminal() && (!explicit || !input.yes)) {
    throw new YggError("Keeping a checkout non-interactively requires --adopt and --yes.");
  }
  const source = typeof input.adopt === "string" ? input.adopt : ".";
  const requested: AdoptionOptions = {
    worktreeDir: input.worktreesDir,
    remote: input.remote === false ? null : input.remote,
    defaultBranch: input.defaultBranch,
  };
  let inspection = await inspectAdoption(source, requested, explicit, context);
  if (inspection.existingWorkspace) {
    await context.workspaces.ensureSharedDirectory(inspection.existingWorkspace);
    await success(
      `Workspace already initialized at ${inspection.existingWorkspace.root}`,
      context.output,
    );
    if (input.config) {
      await maybeInitializeProjectConfig(
        inspection.existingWorkspace.primaryWorktree,
        input,
        context,
      );
    }
    return;
  }
  inspection = await resolveRepositorySettings(
    source,
    requested,
    inspection,
    Boolean(input.yes),
    context,
  );
  if (inspection.worktreeDirSelectionRequired) {
    if (!isInteractiveTerminal() || input.yes) {
      throw new YggError("Could not select a safe worktree directory. Use --worktrees-dir.");
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
  await success(`Connected existing checkout to ygg at ${workspace.root}`, context.output);
  writeLine(context.output.stdout, `Worktrees: ${workspace.worktreeDir}`);
  await maybeInitializeProjectConfig(workspace.primaryWorktree, input, context);
  writeLine(context.output.stdout, "Create another worktree: ygg create <branch> --cd");
}

async function maybeInitializeProjectConfig(
  primaryWorktree: string | null,
  input: InitInput,
  context: CliContext,
): Promise<void> {
  if (!primaryWorktree) {
    if (input.config) {
      throw new YggError(
        "Cannot create .ygg.yml while retaining a bare repository without a worktree. Create a worktree, then run ygg config init.",
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
      (await confirm("Create an initial .ygg.yml now?", true)));
  if (!shouldCreate) {
    writeLine(context.output.stdout, "Optional: ygg config init");
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
    if (!explicit && error instanceof YggError && error.message.startsWith("Not a Git")) {
      throw new YggError("No Git repository detected. Use ygg init <repository> [directory].");
    }
    throw error;
  }
}

async function resolveRepositorySettings(
  source: string,
  requested: AdoptionOptions,
  initialInspection: AdoptionInspection,
  acceptDetected: boolean,
  context: CliContext,
): Promise<AdoptionInspection> {
  let inspection = initialInspection;
  if (inspection.remoteSelectionRequired) {
    if (!isInteractiveTerminal() || acceptDetected) {
      throw new YggError("Multiple remotes found. Select one with --remote or --no-remote.");
    }
    const selected = await selectValue("Select the remote ygg should use:", [
      ...inspection.remotes.map((remote) => ({ label: remote, value: remote })),
      { label: "No remote (local only)", value: "__none__" },
    ]);
    if (!selected) throw new YggError("No remote selected.");
    requested.remote = selected === "__none__" ? null : selected;
    inspection = await context.workspaces.inspectAdoption(source, requested);
  }
  if (!inspection.defaultBranch) {
    if (!isInteractiveTerminal() || acceptDetected) {
      throw new YggError("Could not determine the default branch. Use --default-branch.");
    }
    const custom = "__custom__";
    const selected = await searchSelect("Select the default branch:", [
      ...inspection.defaultBranchCandidates.map((branch) => ({ label: branch, value: branch })),
      { label: "Enter another branch", value: custom },
    ]);
    if (!selected) throw new YggError("No default branch selected.");
    requested.defaultBranch = selected === custom ? await promptText("Default branch:") : selected;
    inspection = await context.workspaces.inspectAdoption(source, requested);
  }
  return inspection;
}

async function inspectExistingRepositoryOrNull(
  source: string,
  context: CliContext,
): Promise<AdoptionInspection | null> {
  try {
    return await runTask("Inspecting repository", () => context.workspaces.inspectAdoption(source));
  } catch (error) {
    if (
      error instanceof YggError &&
      (error.message.startsWith("Not a Git") ||
        error.message.startsWith("Repository path does not exist"))
    ) {
      return null;
    }
    throw error;
  }
}

function hasAdoptionOptions(input: InitInput): boolean {
  return (
    input.adopt !== undefined ||
    input.remote !== undefined ||
    input.defaultBranch !== undefined ||
    input.config === true ||
    input.yes === true
  );
}

function hasExplicitAdoptionInput(input: InitInput): boolean {
  return (
    input.adopt !== undefined ||
    input.worktreesDir !== undefined ||
    input.remote !== undefined ||
    input.defaultBranch !== undefined ||
    input.config !== undefined ||
    input.yes !== undefined
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
    ["Uncommitted changes", inspection.modified ? "yes" : "no"],
    ["Modified worktrees", String(inspection.modifiedWorktrees.length)],
    ["Detached worktrees", String(inspection.detachedWorktrees.length)],
    ["Stashes", String(inspection.stashCount)],
  ];
}
