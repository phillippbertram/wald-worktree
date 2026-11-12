import type { Command } from "commander";
import { WaldError } from "../domain/errors.js";
import type { ProjectConfigDocument, Workspace, Worktree } from "../domain/types.js";
import { summarizeExecutableConfig } from "../services/config-service.js";
import type { WorktreeService } from "../services/worktree-service.js";
import { style } from "../ui/style.js";
import {
  type Choice,
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
  if (all.length === 0) throw new WaldError("The workspace has no worktrees. Use wald create.");
  if (all.length === 1) return all[0] as Worktree;
  if (!isInteractiveTerminal()) throw new WaldError("Specify a worktree without a TTY.");
  const selected = await selectWorktree(all, {
    navigation: options.navigation,
    initialValue: options.initialPath ?? current?.path,
  });
  if (!selected) throw new WaldError("No worktree selected.");
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
  options: { navigation?: PromptNavigation; nonInteractive?: boolean } = {},
): Promise<void> {
  if (context.configs.isTrusted(workspace, project) || !project) return;
  if (options.nonInteractive || !isInteractiveTerminal()) {
    throw new WaldError(
      `Project configuration is not trusted: ${project.path}\nReview it, then run: wald config trust --yes`,
    );
  }
  printTrustSummary(project, context.output);
  if (
    !(await confirm("Trust this project configuration until its behavior changes?", false, {
      navigation: options.navigation,
    }))
  ) {
    throw new WaldError("Project configuration was not trusted; no configured actions were run.");
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
  state: { selectedValue?: string; branchValue?: string; searchValue?: string } = {},
): Promise<string> {
  if (!isInteractiveTerminal()) throw new WaldError("Branch is required without a TTY.");
  const checkedOut = new Map(
    (await worktrees.list(workspace))
      .filter((item) => item.branch)
      .map((item) => [item.branch, item]),
  );
  const unique = new Map<string, Choice>();
  for (const candidate of await worktrees.listBranchCandidates(workspace)) {
    if (!unique.has(candidate.name) || candidate.source === "local") {
      unique.set(candidate.name, {
        label: `${style.branch(candidate.name)}${candidate.label.slice(candidate.name.length)}${checkedOut.has(candidate.name) ? ` (in ${style.worktree(checkedOut.get(candidate.name)?.name ?? "worktree")})` : ""}`,
        value: candidate.name,
        disabled: checkedOut.has(candidate.name),
      });
    }
  }
  const createValue = "__create_new_branch__";
  while (true) {
    const selected = await searchSelect(
      "Create › Branch · Select a branch or create a new one:",
      [{ label: "Create a new branch", value: createValue }, ...unique.values()],
      {
        navigation: "cancel",
        initialValue: state.selectedValue,
        initialSearch: state.searchValue,
        createChoice: (search) => {
          state.searchValue = search;
          return search && !unique.has(search)
            ? {
                label: `Create branch ${style.branch(search)}`,
                value: `new:${search}`,
              }
            : undefined;
        },
      },
    );
    state.selectedValue = selected;
    if (selected.startsWith("new:")) {
      const branch = selected.slice(4);
      try {
        await worktrees.validateBranch(workspace, branch);
        return branch;
      } catch (error) {
        if (!(error instanceof WaldError)) throw error;
        await printStatus("error", style.danger(error.message));
        state.searchValue = branch;
        continue;
      }
    }
    if (selected !== createValue) return selected;
    try {
      const branch = await promptText("Create › New branch · Branch name:", state.branchValue, {
        navigation: "back",
        validate: (value) =>
          value ? undefined : "Enter a branch name, for example feature/payment.",
        validateAsync: async (value) => {
          await worktrees.validateBranch(workspace, value);
          if (checkedOut.has(value))
            throw new WaldError(
              `Branch ${value} is already checked out in ${checkedOut.get(value)?.name}. Choose another branch or open its worktree.`,
            );
        },
      });
      state.branchValue = branch;
      if (!branch) throw new WaldError("Branch cannot be empty.");
      return branch;
    } catch (error) {
      if (isPromptBackError(error)) continue;
      throw error;
    }
  }
}

export async function chooseNewBranch(
  prompt = "Create › New branch · Branch name:",
  state: { branchValue?: string } = {},
  validateAsync?: (value: string) => Promise<void>,
): Promise<string> {
  if (!isInteractiveTerminal()) throw new WaldError("Branch is required without a TTY.");
  const branch = await promptText(prompt, state.branchValue, {
    navigation: "cancel",
    validate: (value) => (value ? undefined : "Enter a new branch name."),
    validateAsync,
  });
  state.branchValue = branch;
  if (!branch) throw new WaldError("Branch cannot be empty.");
  return branch;
}

export function optionValueIfExplicit<T>(command: Command, name: string, value: T): T | undefined {
  return command.getOptionValueSource(name) === "cli" ? value : undefined;
}

export async function findWorkspaceOrNull(context: CliContext): Promise<Workspace | null> {
  try {
    return await context.workspaces.find();
  } catch (error) {
    if (error instanceof WaldError && error.message.startsWith("No wald workspace found"))
      return null;
    throw error;
  }
}

export function removalError(worktree: Worktree, blockers: string[]): WaldError {
  return new WaldError(
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
