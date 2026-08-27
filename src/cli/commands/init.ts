import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { YggError } from "../../domain/errors.js";
import type { ProjectConfigDocument, Workspace } from "../../domain/types.js";
import { humanizeRepositoryName } from "../../infrastructure/path-utils.js";
import type { AdoptionInspection, AdoptionOptions } from "../../services/workspace-service.js";
import {
  confirm,
  isInteractiveTerminal,
  isPromptBackError,
  printKeyValueTable,
  promptText,
  runTask,
  searchSelect,
  selectValue,
} from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { ensureTrusted, shellQuote, success, writeLine } from "../helpers.js";
import {
  initializationPreviewSummary,
  renderInitializationPreview,
  type WorkspaceInitializationPreview,
} from "../init-preview.js";
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

export async function initializeWorkspace(
  input: InitInput,
  context: CliContext,
): Promise<Workspace | null> {
  if (!input.repository) {
    if (isInteractiveTerminal() && !hasExplicitAdoptionInput(input)) {
      return await initializeGuidedWorkspace(context);
    }
    return await initializeAdoptedWorkspace(input, context);
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
  return workspace;
}

async function initializeGuidedWorkspace(context: CliContext): Promise<Workspace | null> {
  const current = await inspectExistingRepositoryOrNull(".", context);
  if (!current) {
    return await initializeGuidedSource(context);
  }
  return await initializeGuidedExistingRepository(current, context);
}

async function initializeGuidedExistingRepository(
  inspection: AdoptionInspection,
  context: CliContext,
): Promise<Workspace | null> {
  if (inspection.existingWorkspace) {
    await context.workspaces.ensureSharedDirectory(inspection.existingWorkspace);
    await success(
      `Workspace already initialized at ${inspection.existingWorkspace.root}`,
      context.output,
    );
    const worktrees = await context.worktrees.list(inspection.existingWorkspace);
    const preferred =
      (await context.worktrees.current(inspection.existingWorkspace)) ??
      worktrees.find(
        (worktree) => worktree.branch === inspection.existingWorkspace?.config.defaultBranch,
      ) ??
      worktrees[0] ??
      null;
    await maybeInitializeProjectConfig(preferred?.path ?? null, {}, context);
    return inspection.existingWorkspace;
  }

  const keepRecommended = inspection.modifiedWorktrees.length > 0 || inspection.stashCount > 0;
  const keepLabel = inspection.bare
    ? "Use this bare repository in place"
    : "Keep this checkout as the primary worktree";
  const copyLabel = "Create a separate Ygg workspace from committed history";
  let previousChoice: string | undefined;
  while (true) {
    const choice = await selectValue(
      inspection.bare
        ? "Initialize › Layout · How should ygg organize this bare repository?"
        : "Initialize › Layout · How should ygg organize this repository?",
      [
        ...(keepRecommended
          ? [
              {
                label: `${keepLabel} (recommended)`,
                value: "keep",
                description: inspection.bare
                  ? "Keep this Git database here and create working checkouts elsewhere."
                  : "Keep local and ignored files here; create additional checkouts elsewhere.",
              },
              {
                label: copyLabel,
                value: "copy",
                description:
                  "Copy committed history independently; uncommitted, ignored, stashed, and unbranched detached work stays here.",
              },
            ]
          : [
              {
                label: `${copyLabel} (recommended)`,
                value: "copy",
                description: inspection.bare
                  ? "Copy branch history into a physically independent Ygg workspace."
                  : "Copy committed history independently; uncommitted, ignored, stashed, and unbranched detached work stays here.",
              },
              {
                label: keepLabel,
                value: "keep",
                description: inspection.bare
                  ? "Keep this Git database here and create working checkouts elsewhere."
                  : "Keep local and ignored files here; create additional checkouts elsewhere.",
              },
            ]),
      ],
      { navigation: "cancel", initialValue: previousChoice },
    );
    if (!choice) {
      writeLine(context.output.stdout, "Cancelled.");
      return null;
    }
    previousChoice = choice;
    try {
      if (choice === "keep") {
        let worktreesDir: string | null = null;
        while (!worktreesDir) {
          worktreesDir = await promptForAdoptedWorktreeDirectory(inspection, context);
          if (!worktreesDir) return null;
          try {
            return await initializeAdoptedWorkspace(
              { adopt: inspection.source, worktreesDir },
              context,
            );
          } catch (error) {
            if (!isPromptBackError(error)) throw error;
            worktreesDir = null;
          }
        }
      }
      if (choice === "copy") return await initializeCopiedWorkspace(inspection, context);
    } catch (error) {
      if (isPromptBackError(error)) continue;
      throw error;
    }
  }
}

async function promptForAdoptedWorktreeDirectory(
  inspection: AdoptionInspection,
  context: CliContext,
): Promise<string | null> {
  const requested = await promptText(
    "Initialize › Worktrees · Directory for new worktrees (name or path):",
    inspection.worktreeDir,
    { navigation: "back" },
  );
  if (!requested) {
    writeLine(context.output.stdout, "Cancelled.");
    return null;
  }
  if (path.isAbsolute(requested)) return requested;
  const repositoryParent = inspection.primaryWorktree
    ? path.dirname(inspection.primaryWorktree)
    : path.dirname(inspection.gitDir);
  return path.resolve(repositoryParent, requested);
}

async function initializeGuidedSource(context: CliContext): Promise<Workspace | null> {
  writeLine(context.output.stdout, `No Git repository or ygg workspace found in ${process.cwd()}.`);
  let previousSource: string | undefined;
  while (true) {
    const source = await selectValue(
      "Initialize › Source · How would you like to start?",
      [
        {
          label: "Clone a remote repository",
          value: "remote",
          description: "Use an SSH or HTTPS URL from GitHub, GitLab, or another Git host.",
        },
        {
          label: "Use an existing local repository",
          value: "local",
          description: "Use an existing checkout or bare repository on this computer.",
        },
      ],
      { navigation: "cancel", initialValue: previousSource },
    );
    if (!source) {
      writeLine(context.output.stdout, "Cancelled.");
      return null;
    }
    previousSource = source;
    try {
      if (source === "local") return await initializeGuidedLocalSource(context);
      return await initializeGuidedRemoteSource(context);
    } catch (error) {
      if (isPromptBackError(error)) continue;
      throw error;
    }
  }
}

async function initializeGuidedRemoteSource(context: CliContext): Promise<Workspace | null> {
  let repository: string | undefined;
  let directory: string | undefined;
  let worktreeDir: string | undefined;
  let step = 0;
  while (step < 4) {
    try {
      if (step === 0) {
        repository = await promptText(
          "Initialize › Remote · Remote repository URL (SSH or HTTPS):",
          repository,
          { navigation: "back" },
        );
        if (!repository) {
          writeLine(context.output.stdout, "Cancelled.");
          return null;
        }
        await rejectExistingLocalPath(repository);
      } else if (step === 1) {
        directory = await promptText(
          "Initialize › Destination · Workspace root:",
          directory ?? humanizeRepositoryName(repository as string),
          { navigation: "back" },
        );
        if (!directory) {
          writeLine(context.output.stdout, "Cancelled.");
          return null;
        }
      } else if (step === 2) {
        worktreeDir = await chooseManagedWorktreeDirectory(worktreeDir);
      } else {
        const target = await context.workspaces.planManagedInitialization(
          repository as string,
          directory as string,
          process.cwd(),
          { worktreeDir },
        );
        if (
          !(await confirmInitialization(
            {
              mode: "remote",
              source: repository as string,
              target,
              remoteName: "origin",
              defaultBranch: null,
            },
            context,
          ))
        ) {
          return null;
        }
      }
      step += 1;
    } catch (error) {
      if (!isPromptBackError(error)) throw error;
      if (step === 0) throw error;
      step -= 1;
    }
  }
  const workspace = await runTask("Initializing workspace", () =>
    context.workspaces.initialize(repository as string, directory, process.cwd(), {
      worktreeDir,
    }),
  );
  await success(`Initialized workspace at ${workspace.root}`, context.output);
  await completeNewWorkspace(workspace, context);
  return workspace;
}

async function initializeGuidedLocalSource(context: CliContext): Promise<Workspace | null> {
  const repository = await promptText("Initialize › Local · Local repository path:", undefined, {
    navigation: "back",
  });
  if (!repository) {
    writeLine(context.output.stdout, "Cancelled.");
    return null;
  }
  const inspection = await inspectAdoption(repository, {}, true, context);
  return await initializeGuidedExistingRepository(inspection, context);
}

async function initializeCopiedWorkspace(
  initialInspection: AdoptionInspection,
  context: CliContext,
): Promise<Workspace | null> {
  const requested: AdoptionOptions = {};
  const inspection = await resolveRepositorySettings(
    initialInspection.source,
    requested,
    initialInspection,
    false,
    context,
  );
  const sourceRepository = inspection.primaryWorktree ?? inspection.gitDir;
  const repositoryName = path.basename(sourceRepository).replace(/\.git$/u, "") || "repository";
  const suggestedRoot = path.join(path.dirname(sourceRepository), `${repositoryName}-workspace`);
  let directory: string | undefined;
  let worktreeDir: string | undefined;
  let step = 0;
  while (step < 3) {
    try {
      if (step === 0) {
        directory = await promptText(
          "Initialize › Destination · New workspace root:",
          directory ?? suggestedRoot,
          { navigation: "back" },
        );
        if (!directory) {
          writeLine(context.output.stdout, "Cancelled.");
          return null;
        }
      } else if (step === 1) {
        worktreeDir = await chooseManagedWorktreeDirectory(worktreeDir);
      } else {
        const target = await context.workspaces.planManagedInitialization(
          inspection.source,
          directory as string,
          process.cwd(),
          { worktreeDir },
        );
        if (
          !(await confirmInitialization(
            {
              mode: "copy",
              source: sourceRepository,
              target,
              remoteName: inspection.remoteName,
              defaultBranch: inspection.defaultBranch,
              modifiedWorktrees: inspection.modifiedWorktrees,
              detachedWorktrees: inspection.detachedWorktrees,
              stashCount: inspection.stashCount,
            },
            context,
          ))
        ) {
          return null;
        }
      }
      step += 1;
    } catch (error) {
      if (!isPromptBackError(error)) throw error;
      if (step === 0) throw error;
      step -= 1;
    }
  }
  const target = await context.workspaces.planManagedInitialization(
    inspection.source,
    directory as string,
    process.cwd(),
    { worktreeDir },
  );
  const workspace = await runTask("Creating standalone workspace", () =>
    context.workspaces.initializeFromExisting(inspection, target.root, process.cwd(), {
      worktreeDir,
    }),
  );
  await success(`Initialized workspace at ${workspace.root}`, context.output);
  writeLine(context.output.stdout, `Original repository kept at ${sourceRepository}`);
  await completeNewWorkspace(workspace, context);
  return workspace;
}

async function chooseManagedWorktreeDirectory(initialValue?: string): Promise<string> {
  const custom = "__custom__";
  let selectedValue =
    initialValue === "." || initialValue === "worktrees"
      ? initialValue
      : initialValue
        ? custom
        : undefined;
  let customValue =
    initialValue && initialValue !== "." && initialValue !== "worktrees" ? initialValue : undefined;
  while (true) {
    const selected = await selectValue(
      "Initialize › Layout · Where should worktrees be created?",
      [
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
      ],
      { navigation: "back", initialValue: selectedValue },
    );
    selectedValue = selected;
    if (selected !== custom) return selected;
    try {
      const value = await promptText(
        "Initialize › Layout · Worktree directory inside the workspace root:",
        customValue ?? "worktrees",
        { navigation: "back" },
      );
      customValue = value;
      if (!value) throw new YggError("Worktree directory cannot be empty.");
      return value;
    } catch (error) {
      if (isPromptBackError(error)) continue;
      throw error;
    }
  }
}

async function completeNewWorkspace(
  workspace: Awaited<ReturnType<CliContext["workspaces"]["find"]>>,
  context: CliContext,
): Promise<void> {
  writeLine(context.output.stdout, "");
  writeLine(context.output.stdout, "Optional setup");
  const plan = await runTask("Preparing default worktree", () =>
    context.workflow.planCreate(workspace, {
      branch: workspace.config.defaultBranch,
      fetch: false,
    }),
  );
  await printKeyValueTable([
    ["Default branch", plan.prepared.branch],
    ["New worktree", plan.prepared.target],
  ]);
  let createFirstWorktree = false;
  try {
    createFirstWorktree = await confirm("Create this first worktree now?", true, {
      navigation: "cancel",
    });
  } catch (error) {
    if (!isPromptBackError(error)) throw error;
  }
  if (!createFirstWorktree) {
    writeLine(context.output.stdout, "Workspace remains initialized; no worktree was created.");
    writeLine(context.output.stdout, `Next: cd ${shellQuote(workspace.root)}`);
    writeLine(
      context.output.stdout,
      `Then: ygg create ${shellQuote(workspace.config.defaultBranch)} --cd`,
    );
    return;
  }
  await ensureTrusted(workspace, plan.project, context);
  const created = await context.workflow.executeCreate(plan, {
    output: context.output.stderr,
  });
  await success(`Created ${created.name} at ${created.path}`, context.output);
  await maybeInitializeProjectConfig(created.path, {}, context);
  writeLine(context.output.stdout, `Next: cd ${shellQuote(created.path)}`);
  writeLine(context.output.stdout, "Then create a feature worktree with: ygg create <branch> --cd");
}

async function initializeAdoptedWorkspace(
  input: InitInput,
  context: CliContext,
): Promise<Workspace | null> {
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
    return inspection.existingWorkspace;
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
      { navigation: "cancel" },
    );
    inspection = await context.workspaces.inspectAdoption(source, requested);
  }
  const validation = await context.workspaces.validateAdoption(inspection);
  if (isInteractiveTerminal() && !input.yes) {
    if (
      !(await confirmInitialization(
        {
          mode: "adopt",
          inspection,
          worktreeDirExisted: validation.worktreeDirExisted,
        },
        context,
      ))
    ) {
      return null;
    }
  }
  const workspace = await runTask("Adopting repository", () =>
    context.workspaces.adopt(inspection),
  );
  await success(`Connected existing checkout to ygg at ${workspace.root}`, context.output);
  writeLine(context.output.stdout, `Worktrees: ${workspace.worktreeDir}`);
  await maybeInitializeProjectConfig(workspace.primaryWorktree, input, context);
  writeLine(context.output.stdout, "Create another worktree: ygg create <branch> --cd");
  return workspace;
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
  let shouldCreate = requested;
  if (!requested && isInteractiveTerminal() && !input.yes) {
    writeLine(context.output.stdout, "");
    writeLine(context.output.stdout, "Project automation (optional)");
    writeLine(
      context.output.stdout,
      "A .ygg.yml can prepare new worktrees and define dev or verify tasks.",
    );
    try {
      shouldCreate = await confirm("Configure optional project automation (.ygg.yml) now?", true, {
        navigation: "cancel",
      });
    } catch (error) {
      if (!isPromptBackError(error)) throw error;
      shouldCreate = false;
    }
  }
  if (!shouldCreate) {
    writeLine(
      context.output.stdout,
      "Workspace remains initialized; no project config was written.",
    );
    writeLine(context.output.stdout, "Later: ygg config init");
    return;
  }
  let document: ProjectConfigDocument | null;
  try {
    document = await initializeProjectConfiguration(
      primaryWorktree,
      { force: false, yes: Boolean(input.yes) },
      context,
    );
  } catch (error) {
    if (!isPromptBackError(error)) throw error;
    writeLine(
      context.output.stdout,
      "Workspace remains initialized; project configuration was cancelled.",
    );
    writeLine(context.output.stdout, "Later: ygg config init");
    return;
  }
  if (!document) {
    writeLine(
      context.output.stdout,
      "Workspace remains initialized; no project config was written.",
    );
  }
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
  const remoteWasRequired = inspection.remoteSelectionRequired;
  let selectedRemote = requested.remote ?? inspection.remoteName ?? undefined;
  if (inspection.remoteSelectionRequired) {
    if (!isInteractiveTerminal() || acceptDetected) {
      throw new YggError("Multiple remotes found. Select one with --remote or --no-remote.");
    }
    const selected = await selectValue(
      "Initialize › Repository · Select the remote ygg should use:",
      [
        ...inspection.remotes.map((remote) => ({ label: remote, value: remote })),
        { label: "No remote (local only)", value: "__none__" },
      ],
      { navigation: "back", initialValue: selectedRemote },
    );
    selectedRemote = selected;
    requested.remote = selected === "__none__" ? null : selected;
    inspection = await context.workspaces.inspectAdoption(source, requested);
  }
  while (!inspection.defaultBranch) {
    if (inspection.defaultBranchCandidates.length === 0) {
      throw new YggError(
        "Repository has no commits. Ygg requires an existing branch with at least one commit.",
      );
    }
    if (!isInteractiveTerminal() || acceptDetected) {
      throw new YggError("Could not determine the default branch. Use --default-branch.");
    }
    const custom = "__custom__";
    let selected: string;
    try {
      selected = await searchSelect(
        "Initialize › Repository · Select the default branch:",
        [
          ...inspection.defaultBranchCandidates.map((branch) => ({
            label: branch,
            value: branch,
          })),
          { label: "Enter another branch", value: custom },
        ],
        { navigation: "back", initialValue: requested.defaultBranch },
      );
    } catch (error) {
      if (!isPromptBackError(error) || !remoteWasRequired) throw error;
      const remote = await selectValue(
        "Initialize › Repository · Select the remote ygg should use:",
        [
          ...initialInspection.remotes.map((name) => ({ label: name, value: name })),
          { label: "No remote (local only)", value: "__none__" },
        ],
        { navigation: "back", initialValue: selectedRemote },
      );
      selectedRemote = remote;
      requested.remote = remote === "__none__" ? null : remote;
      requested.defaultBranch = undefined;
      inspection = await context.workspaces.inspectAdoption(source, requested);
      continue;
    }
    if (selected === custom) {
      try {
        requested.defaultBranch = await promptText(
          "Initialize › Repository · Default branch:",
          requested.defaultBranch,
          { navigation: "back" },
        );
      } catch (error) {
        if (isPromptBackError(error)) continue;
        throw error;
      }
    } else {
      requested.defaultBranch = selected;
    }
    if (!requested.defaultBranch) throw new YggError("Default branch cannot be empty.");
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

async function confirmInitialization(
  preview: WorkspaceInitializationPreview,
  context: CliContext,
): Promise<boolean> {
  writeLine(context.output.stdout, "");
  writeLine(context.output.stdout, "Workspace plan");
  await printKeyValueTable(initializationPreviewSummary(preview));
  writeLine(context.output.stdout, "");
  writeLine(context.output.stdout, renderInitializationPreview(preview));
  writeLine(context.output.stdout, "");
  if (await confirm("Initialize this workspace?", true, { navigation: "back" })) return true;
  writeLine(context.output.stdout, "Cancelled. No files were changed.");
  return false;
}

async function rejectExistingLocalPath(repository: string): Promise<void> {
  if (repository.startsWith("file://")) return;
  const candidate = path.resolve(repository);
  try {
    await fs.access(candidate);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new YggError(
    `This is a local path: ${candidate}. Choose "Use an existing local repository" instead.`,
  );
}
