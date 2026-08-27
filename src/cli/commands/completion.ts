import type { RootCommand } from "@bomb.sh/tab";
import tab from "@bomb.sh/tab/commander";
import type { Command } from "commander";
import { hookEvents } from "../../domain/types.js";
import type { CliContext } from "../context.js";
import { findWorkspaceOrNull } from "../helpers.js";

const supportedShells = ["zsh", "bash", "fish"] as const;
const completionDescription = "Generate shell completion and navigation integration";

type CompletionKind = "worktrees" | "renamableWorktrees" | "branches" | "tasks" | "tools";
type CompletionCandidate = { value: string; description: string };
type CompletionCandidates = Record<CompletionKind, CompletionCandidate[]>;

export function registerCompletionCommand(program: Command, context: CliContext): void {
  const completion = tab(program, { completionCommandName: "completion" });
  const publicCommand = findRegisteredCommand(program, "completion");
  const runtimeCommand = findRegisteredCommand(program, "complete");

  publicCommand
    .description(completionDescription)
    .addHelpText(
      "after",
      '\nExamples:\n  eval "$(ygg completion zsh)"\n  eval "$(ygg completion bash)"\n  ygg completion fish | source\n',
    )
    .hook("preAction", (_thisCommand, actionCommand) => {
      const shell = actionCommand.processedArgs[0];
      if (typeof shell === "string") context.output.stdout.write(context.shells.render(shell));
    });

  const shellArgument = publicCommand.registeredArguments[0];
  if (!shellArgument) throw new Error("Bombshell did not register the completion shell argument.");
  shellArgument.choices([...supportedShells]);

  const completionMetadata = requiredTabCommand(completion, "completion");
  completionMetadata.description = completionDescription;
  const shellMetadata = completionMetadata.arguments.get("shell");
  if (!shellMetadata) throw new Error("Bombshell did not expose the completion shell argument.");
  shellMetadata.handler = (complete) => {
    for (const shell of supportedShells) complete(shell, "");
  };

  const hookEventMetadata = requiredTabCommand(completion, "hook run").arguments.get("event");
  if (!hookEventMetadata) throw new Error("Bombshell did not expose the hook event argument.");
  hookEventMetadata.handler = (complete) => {
    for (const event of hookEvents) complete(event, "lifecycle hook");
  };

  runtimeCommand.hook("preAction", async (_thisCommand, actionCommand) => {
    const args = actionCommand.processedArgs[0];
    const request = Array.isArray(args)
      ? args.filter((value): value is string => typeof value === "string")
      : [];
    const kinds = requestedCompletionKinds(request);
    const candidates = await loadCompletionCandidates(kinds, context);
    applyDynamicHandlers(completion, candidates);
  });
}

function findRegisteredCommand(program: Command, name: string): Command {
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (!command) throw new Error(`Bombshell did not register the ${name} command.`);
  return command;
}

function requiredTabCommand(completion: RootCommand, path: string) {
  const command = completion.commands.get(path);
  if (!command) throw new Error(`Bombshell did not register completion metadata for ${path}.`);
  return command;
}

function requestedCompletionKinds(args: string[]): Set<CompletionKind> {
  switch (args[0]) {
    case "create":
      return args.includes("--carry") ? new Set(["tools"]) : new Set(["branches", "tools"]);
    case "handoff":
      return new Set(["tools"]);
    case "cd":
    case "setup":
    case "remove":
    case "exec":
      return new Set(["worktrees"]);
    case "rename":
      return new Set(["renamableWorktrees"]);
    case "open":
      return new Set(["worktrees", "tools"]);
    case "run":
      return new Set(["tasks", "worktrees"]);
    case "hook":
      return args[1] === "run" ? new Set(["worktrees"]) : new Set();
    case "config":
      return args[1] === "init" ? new Set(["worktrees"]) : new Set();
    default:
      return new Set();
  }
}

async function loadCompletionCandidates(
  kinds: Set<CompletionKind>,
  context: CliContext,
): Promise<CompletionCandidates> {
  const candidates = emptyCompletionCandidates();
  if (kinds.size === 0) return candidates;

  const workspace = await findWorkspaceOrNull(context);
  if (!workspace) return candidates;

  const needsWorktrees = kinds.has("worktrees") || kinds.has("tasks") || kinds.has("tools");
  const [worktrees, renamableWorktrees, branchCandidates] = await Promise.all([
    needsWorktrees ? context.worktrees.list(workspace) : Promise.resolve([]),
    kinds.has("renamableWorktrees")
      ? context.worktrees.listMoveCandidates(workspace)
      : Promise.resolve([]),
    kinds.has("branches") ? context.worktrees.listBranchCandidates(workspace) : Promise.resolve([]),
  ]);

  if (kinds.has("worktrees")) {
    candidates.worktrees = worktrees.map((worktree) => ({
      value: worktree.name,
      description: `${worktree.branch ?? "detached HEAD"} (${worktree.state})`,
    }));
  }

  if (kinds.has("renamableWorktrees")) {
    candidates.renamableWorktrees = worktreeCandidates(renamableWorktrees);
  }

  if (kinds.has("branches")) {
    const unique = new Map<string, CompletionCandidate>();
    for (const branch of branchCandidates) {
      if (!unique.has(branch.name) || branch.source === "local") {
        unique.set(branch.name, {
          value: branch.name,
          description:
            branch.source === "local"
              ? "local branch"
              : `${workspace.config.remote?.name ?? "remote"} branch`,
        });
      }
    }
    candidates.branches = [...unique.values()].sort((left, right) =>
      left.value.localeCompare(right.value),
    );
  }

  if (!kinds.has("tasks") && !kinds.has("tools")) return candidates;
  const worktree = (await context.worktrees.current(workspace)) ?? worktrees[0];
  if (!worktree) return candidates;
  const project = await context.configs.resolveProjectConfig(workspace, worktree.path);

  if (kinds.has("tasks")) {
    candidates.tasks = Object.entries(project?.config.tasks ?? {})
      .map(([name, task]) => ({
        value: name,
        description: task.description ?? "project task",
      }))
      .sort((left, right) => left.value.localeCompare(right.value));
  }

  if (kinds.has("tools")) {
    candidates.tools = (await context.tools.availableProfiles(project, worktree)).map(
      ({ name, profile }) => ({
        value: name,
        description: profile.description ?? "tool profile",
      }),
    );
  }

  return candidates;
}

function emptyCompletionCandidates(): CompletionCandidates {
  return { worktrees: [], renamableWorktrees: [], branches: [], tasks: [], tools: [] };
}

function applyDynamicHandlers(completion: RootCommand, candidates: CompletionCandidates): void {
  setArgumentHandler(completion, "create", "branch", candidates.branches);
  for (const command of ["cd", "open", "setup", "remove", "exec"]) {
    setArgumentHandler(
      completion,
      command,
      command === "remove" ? "worktrees" : "worktree",
      candidates.worktrees,
    );
  }
  setArgumentHandler(completion, "rename", "worktree", candidates.renamableWorktrees);
  setArgumentHandler(completion, "run", "task", candidates.tasks);
  setArgumentHandler(completion, "run", "worktree", candidates.worktrees);
  setArgumentHandler(completion, "hook run", "worktree", candidates.worktrees);
  setArgumentHandler(completion, "config init", "worktree", candidates.worktrees);
  setOptionHandler(completion, "create", "tool", candidates.tools);
  setOptionHandler(completion, "handoff", "tool", candidates.tools);
  setOptionHandler(completion, "open", "tool", candidates.tools);
  const scopes = [
    { value: "workspace", description: "workspace-local configuration" },
    { value: "project", description: "repository project configuration" },
  ];
  setOptionHandler(completion, "init", "config-scope", scopes);
  setOptionHandler(completion, "config init", "scope", scopes);
}

function worktreeCandidates(worktrees: Awaited<ReturnType<CliContext["worktrees"]["list"]>>) {
  return worktrees.map((worktree) => ({
    value: worktree.name,
    description: `${worktree.branch ?? "detached HEAD"} (${worktree.state})`,
  }));
}

function setArgumentHandler(
  completion: RootCommand,
  commandPath: string,
  argumentName: string,
  candidates: CompletionCandidate[],
): void {
  const argument = requiredTabCommand(completion, commandPath).arguments.get(argumentName);
  if (!argument) {
    throw new Error(`Bombshell did not expose ${commandPath} argument ${argumentName}.`);
  }
  argument.handler = (complete) => {
    for (const candidate of candidates) complete(candidate.value, candidate.description);
  };
}

function setOptionHandler(
  completion: RootCommand,
  commandPath: string,
  optionName: string,
  candidates: CompletionCandidate[],
): void {
  const option = requiredTabCommand(completion, commandPath).options.get(optionName);
  if (!option) throw new Error(`Bombshell did not expose ${commandPath} option ${optionName}.`);
  option.handler = (complete) => {
    for (const candidate of candidates) complete(candidate.value, candidate.description);
  };
}
