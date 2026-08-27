import type { Command } from "commander";
import { YggError } from "../domain/errors.js";
import type { ProjectConfigDocument, Workspace, Worktree } from "../domain/types.js";
import { summarizeExecutableConfig } from "../services/config-service.js";
import type { WorktreeService } from "../services/worktree-service.js";
import {
  confirm,
  isInteractiveTerminal,
  isPromptBackError,
  type PromptNavigation,
  printStatus,
  promptText,
  searchSelect,
  selectWorktree,
} from "../ui/terminal.js";
import type { CliContext, CliOutput } from "./context.js";

export async function resolveWorktree(
  workspace: Workspace,
  identifier: string | undefined,
  worktrees: WorktreeService,
  options: {
    forcePrompt?: boolean;
    initialPath?: string;
    navigation?: PromptNavigation;
  } = {},
): Promise<Worktree> {
  if (identifier) return await worktrees.resolve(workspace, identifier);
  const current = await worktrees.current(workspace);
  if (current && !options.forcePrompt) return current;
  const all = await worktrees.list(workspace);
  if (all.length === 0) throw new YggError("The workspace has no worktrees. Use ygg create.");
  if (all.length === 1) return all[0] as Worktree;
  if (!isInteractiveTerminal()) throw new YggError("Specify a worktree without a TTY.");
  const selected = await selectWorktree(all, {
    navigation: options.navigation,
    initialValue: options.initialPath ?? current?.path,
  });
  if (!selected) throw new YggError("No worktree selected.");
  return selected;
}

export async function resolveProjectConfiguration(
  workspace: Workspace,
  context: CliContext,
): Promise<ProjectConfigDocument | null> {
  const current = await context.worktrees.current(workspace);
  if (current) return await context.configs.readProjectConfig(current.path);

  const all = await context.worktrees.list(workspace);
  const preferred =
    all.find((worktree) => worktree.branch === workspace.config.defaultBranch) ??
    all.find((worktree) => worktree.role === "primary") ??
    all[0];
  if (preferred) return await context.configs.readProjectConfig(preferred.path);

  const revision = workspace.config.remote
    ? `${workspace.config.remote.name}/${workspace.config.defaultBranch}`
    : workspace.config.defaultBranch;
  return await context.configs.readProjectConfigAtRevision(context.git, workspace, revision);
}

export async function ensureTrusted(
  workspace: Workspace,
  project: ProjectConfigDocument | null,
  context: CliContext,
  options: { navigation?: PromptNavigation } = {},
): Promise<void> {
  if (context.configs.isTrusted(workspace, project) || !project) return;
  if (!isInteractiveTerminal()) {
    throw new YggError(
      `Project configuration is not trusted: ${project.path}\nReview it, then run: ygg config trust --yes`,
    );
  }
  printTrustSummary(project, context.output);
  if (
    !(await confirm("Trust this project configuration until its behavior changes?", false, {
      navigation: options.navigation,
    }))
  ) {
    throw new YggError("Project configuration was not trusted; no configured actions were run.");
  }
  await context.configs.trust(workspace, project);
}

export function printTrustSummary(project: ProjectConfigDocument, output: CliOutput): void {
  writeLine(output.stderr, `Project configuration: ${project.path}`);
  writeLine(output.stderr, `Behavior hash: ${project.hash}`);
  for (const row of summarizeExecutableConfig(project)) writeLine(output.stderr, `- ${row}`);
}

export async function chooseBranch(
  workspace: Workspace,
  worktrees: WorktreeService,
): Promise<string> {
  if (!isInteractiveTerminal()) throw new YggError("Branch is required without a TTY.");
  const unique = new Map<string, { label: string; value: string }>();
  for (const candidate of await worktrees.listBranchCandidates(workspace)) {
    if (!unique.has(candidate.name) || candidate.source === "local") {
      unique.set(candidate.name, { label: candidate.label, value: candidate.name });
    }
  }
  const createValue = "__create_new_branch__";
  let selectedValue: string | undefined;
  let branchValue: string | undefined;
  while (true) {
    const selected = await searchSelect(
      "Create › Branch · Select a branch or create a new one:",
      [{ label: "Create a new branch", value: createValue }, ...unique.values()],
      { navigation: "cancel", initialValue: selectedValue },
    );
    selectedValue = selected;
    if (selected !== createValue) return selected;
    try {
      const branch = await promptText("Create › New branch · Branch name:", branchValue, {
        navigation: "back",
      });
      branchValue = branch;
      if (!branch) throw new YggError("Branch cannot be empty.");
      return branch;
    } catch (error) {
      if (isPromptBackError(error)) continue;
      throw error;
    }
  }
}

export function optionValueIfExplicit<T>(command: Command, name: string, value: T): T | undefined {
  return command.getOptionValueSource(name) === "cli" ? value : undefined;
}

export async function findWorkspaceOrNull(context: CliContext): Promise<Workspace | null> {
  try {
    return await context.workspaces.find();
  } catch (error) {
    if (error instanceof YggError && error.message.startsWith("No ygg workspace found"))
      return null;
    throw error;
  }
}

export function removalError(worktree: Worktree, blockers: string[]): YggError {
  return new YggError(
    `Refusing to remove ${worktree.name}:\n${blockers.map((item) => `- ${item}`).join("\n")}`,
  );
}

export function printPlainWorktrees(worktrees: Worktree[], stream: NodeJS.WritableStream): void {
  writeLine(stream, "NAME\tBRANCH\tROLE\tSTATUS\tPATH");
  for (const worktree of worktrees) {
    writeLine(
      stream,
      [
        worktree.name,
        worktree.branch ?? "detached",
        worktree.role,
        worktree.state,
        worktree.path,
      ].join("\t"),
    );
  }
}

export async function success(message: string, output: CliOutput): Promise<void> {
  if (isInteractiveTerminal()) await printStatus("success", message);
  else writeLine(output.stdout, message);
}

export function writeJson(stream: NodeJS.WritableStream, value: unknown): void {
  writeLine(stream, JSON.stringify(value, null, 2));
}

export function writeLine(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
