import { type Command, Option } from "commander";
import { z } from "zod";
import { toErrorMessage, WaldError } from "../../domain/errors.js";
import type { Worktree } from "../../domain/types.js";
import { builtInToolNames } from "../../services/tool-service.js";
import type { CreatedWorktree, CreatePlan } from "../../services/worktree-workflow-service.js";
import { type CreateDestination, printCreatePlan } from "../../ui/create-plan.js";
import { style } from "../../ui/style.js";
import { confirm, isPromptBackError, runTask } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import {
  chooseBranch,
  chooseNewBranch,
  ensureTrusted,
  optionValueIfExplicit,
  shellQuote,
  success,
  writeJson,
  writeLine,
} from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";
import { openSelectedWorktree } from "./open.js";

const createInputSchema = z
  .object({
    branch: nonEmptyCliString.optional(),
    from: nonEmptyCliString.optional(),
    name: nonEmptyCliString.optional(),
    fetch: z.boolean().optional(),
    carry: z.boolean().default(false),
    cd: z.boolean().default(false),
    open: z.boolean().default(false),
    tool: nonEmptyCliString.optional(),
    printPath: z.boolean().default(false),
    json: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.cd && (input.open || input.tool)) {
      context.addIssue({
        code: "custom",
        path: ["cd"],
        message: "Cannot be combined with --open or --tool; choose one destination.",
      });
    }
    if (input.carry && input.from) {
      context.addIssue({
        code: "custom",
        path: ["carry"],
        message: "Cannot be combined with --from; carry always starts at the current HEAD.",
      });
    }
    if (input.json && !input.branch) {
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "JSON mode requires a branch.",
      });
    }
    if (input.json && (input.cd || input.open || input.tool || input.printPath)) {
      context.addIssue({
        code: "custom",
        path: ["json"],
        message: "Cannot be combined with --cd, --open, --tool, or --print-path.",
      });
    }
  });

export type CreateInput = Omit<z.output<typeof createInputSchema>, "json"> & { json?: boolean };

export function registerCreateCommand(program: Command, context: CliContext): void {
  program
    .command("create")
    .alias("plant")
    .description("Create and prepare a worktree for an existing or new branch")
    .argument("[branch]", "Branch to check out or create")
    .option("--from <commit-ish>", "Base commit for a new branch only")
    .option("--name <directory>", "Override the worktree directory name")
    .option("--fetch", "Fetch before resolving the branch")
    .option("--no-fetch", "Do not fetch before resolving the branch")
    .option("--carry", "Carry staged, unstaged, and untracked changes from the current worktree")
    .option("--cd", "Enter after creation; requires shell integration")
    .option("--open", "Open after creation with the configured or selected tool")
    .option("--tool <profile>", "Tool profile to open; implies --open")
    .option("--json", "Emit machine-readable JSON without prompting")
    .addOption(new Option("--print-path").hideHelp())
    .addHelpText(
      "after",
      `\nBuilt-in tools: ${builtInToolNames.join(", ")}\n\nExamples:\n  wald create feature/payment --cd\n  wald create hotfix/payment --from release/1.x --cd\n  wald create feature/review --tool codex\n`,
    )
    .action(
      async (
        branch: unknown,
        options: {
          from?: unknown;
          name?: unknown;
          fetch?: boolean;
          carry?: unknown;
          cd?: unknown;
          open?: unknown;
          tool?: unknown;
          printPath?: unknown;
          json?: unknown;
        },
        command: Command,
      ) => {
        const input = parseCliInput(createInputSchema, {
          branch,
          ...options,
          fetch: optionValueIfExplicit(command, "fetch", options.fetch),
        });
        await createWorktree(input, context);
      },
    );
}

export async function createWorktree(
  input: CreateInput,
  context: CliContext,
): Promise<Worktree | null> {
  const workspace = await context.workspaces.find();
  const promptedForBranch = input.branch === undefined;
  const branchState: { selectedValue?: string; branchValue?: string } = {};
  let plan: CreatePlan;
  while (true) {
    const branch =
      input.branch ??
      (input.carry
        ? await chooseNewBranch("Carry › New branch · Branch name:", branchState)
        : await chooseBranch(workspace, context.worktrees, branchState));
    plan = await prepareCreatePlan(workspace, branch, input, context);
    if (!promptedForBranch) break;
    printCreatePlan(plan, createDestination(input), context.output);
    try {
      if (await confirm("Create this worktree?", true, { navigation: "back" })) break;
      writeLine(context.output.stdout, createCancellationMessage(plan));
      return null;
    } catch (error) {
      if (isPromptBackError(error)) continue;
      throw error;
    }
  }
  await ensureTrusted(workspace, plan.project, context, { nonInteractive: input.json });
  const created = await context.workflow.executeCreate(plan, {
    output: context.output.stderr,
  });

  if (input.json) {
    writeJson(context.output.stdout, createJsonResult(created, plan));
    return created;
  }

  if (input.open || input.tool) {
    try {
      await openSelectedWorktree(created, input.tool, context, {
        silent: input.printPath,
        project: await context.workflow.projectForWorktree(workspace, created),
      });
    } catch (error) {
      if (isPromptBackError(error)) {
        await success(
          `Created ${style.worktree(created.name)} at ${style.path(created.path)}; opening was cancelled.`,
          context.output,
        );
        return created;
      }
      throw new WaldError(
        `Worktree was created at ${created.path}, but opening it failed: ${toErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  if (input.printPath) {
    writeLine(context.output.stdout, created.path);
  } else {
    const carriedChangeCount = created.carry
      ? created.carry.summary.staged +
        created.carry.summary.unstaged +
        created.carry.summary.untracked
      : 0;
    await success(
      carriedChangeCount > 0
        ? `Created ${style.worktree(created.name)} with carried local changes at ${style.path(created.path)}`
        : `Created ${style.worktree(created.name)} at ${style.path(created.path)}`,
      context.output,
    );
    if (created.carry) {
      const { staged, unstaged, untracked } = created.carry.summary;
      if (carriedChangeCount > 0) {
        writeLine(
          context.output.stdout,
          `${style.label("Carried:")} ${staged} staged, ${unstaged} unstaged, ${untracked} untracked`,
        );
      } else {
        writeLine(
          context.output.stdout,
          `${style.label("Carry:")} Source was clean; nothing to copy.`,
        );
      }
      writeLine(
        context.output.stdout,
        `${style.label("Source kept unchanged:")} ${style.path(created.carry.sourcePath)}`,
      );
    }
    if (plan.prepared.strategy.type === "new") {
      writeLine(context.output.stdout, `${style.label("Upstream:")} ${style.value("none")}`);
      if (workspace.config.remote) {
        writeLine(
          context.output.stdout,
          `${style.label("Publish with:")} ${style.command(`git push -u ${shellQuote(workspace.config.remote.name)} HEAD`)}`,
        );
      }
    }
    if (input.cd) {
      writeLine(
        context.output.stdout,
        `Shell integration is not active for this invocation. ${style.label("Enter with:")} ${style.command(`cd ${shellQuote(created.path)}`)}`,
      );
    } else if (!input.open && !input.tool) {
      writeLine(
        context.output.stdout,
        `${style.label("Next:")} ${style.command(`wald cd ${shellQuote(created.name)}`)}`,
      );
      writeLine(
        context.output.stdout,
        `${style.label("Without shell integration:")} ${style.command(`cd ${shellQuote(created.path)}`)}`,
      );
    }
  }
  return created;
}

async function prepareCreatePlan(
  workspace: Awaited<ReturnType<CliContext["workspaces"]["find"]>>,
  branch: string,
  input: CreateInput,
  context: CliContext,
): Promise<CreatePlan> {
  const prepare = () =>
    context.workflow.planCreate(workspace, {
      branch,
      from: input.from,
      name: input.name,
      fetch: input.fetch,
      carry: input.carry,
    });
  return input.json ? await prepare() : await runTask("Preparing worktree", prepare);
}

function createDestination(input: CreateInput): CreateDestination {
  if (input.cd) return { type: "cd" };
  if (input.open || input.tool) return { type: "open", tool: input.tool ?? null };
  return { type: "stay" };
}

function createCancellationMessage(plan: CreatePlan): string {
  if (plan.fetchedRemote) {
    return `Cancelled. No branch, worktree, or configured action was created or run. Only remote refs from ${plan.fetchedRemote} were updated during preparation.`;
  }
  return "Cancelled. No branch, worktree, or configured action was created or run.";
}

function createJsonResult(created: CreatedWorktree, plan: CreatePlan): unknown {
  return {
    action: "created",
    strategy: plan.prepared.strategy,
    worktree: serializeWorktree(created),
    ...(created.carry ? { carry: created.carry } : {}),
  };
}

function serializeWorktree(worktree: Worktree): unknown {
  const { name, branch, path, role, state, head } = worktree;
  return { name, branch, path, role, state, head };
}
