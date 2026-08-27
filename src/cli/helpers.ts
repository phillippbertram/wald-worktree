import type { Command } from "commander";
import { YggError } from "../domain/errors.js";
import type { ProjectConfigDocument, Workspace, Worktree } from "../domain/types.js";
import { summarizeExecutableConfig } from "../services/config-service.js";
import type { WorktreeService } from "../services/worktree-service.js";
import { style } from "../ui/style.js";
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
  const worktrees = await context.worktrees.list(workspace);
  const current = await context.worktrees.currentFromList(worktrees);
  return await context.configs.resolveEffectiveProjectConfig(
    context.git,
    workspace,
    current,
    worktrees,
  );
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
  writeLine(
    output.stderr,
    `${style.label("Repository configuration:")} ${style.path(project.sources.repository ?? "none")}`,
  );
  writeLine(
    output.stderr,
    `${style.label("Workspace configuration:")} ${style.path(project.sources.workspace ?? "none")}`,
  );
  writeLine(output.stderr, `${style.label("Behavior hash:")} ${style.hash(project.hash)}`);
  for (const row of summarizeExecutableConfig(project)) {
    writeLine(output.stderr, `- ${style.value(row)}`);
  }
}

export async function chooseBranch(
  workspace: Workspace,
  worktrees: WorktreeService,
): Promise<string> {
  if (!isInteractiveTerminal()) throw new YggError("Branch is required without a TTY.");
  const unique = new Map<string, { label: string; value: string }>();
  for (const candidate of await worktrees.listBranchCandidates(workspace)) {
    if (!unique.has(candidate.name) || candidate.source === "local") {
      unique.set(candidate.name, {
        label: `${style.branch(candidate.name)}${candidate.label.slice(candidate.name.length)}`,
        value: candidate.name,
      });
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
  writeLine(
    stream,
    ["NAME", "BRANCH", "ROLE", "STATUS", "PATH"].map((header) => style.label(header)).join("\t"),
  );
  for (const worktree of worktrees) {
    writeLine(
      stream,
      [
        style.worktree(worktree.name),
        style.branch(worktree.branch ?? "detached"),
        worktree.role,
        style.state(worktree.state, worktree.state),
        style.path(worktree.path),
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
