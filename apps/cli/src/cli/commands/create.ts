import path from "node:path";
import { type Command, Option } from "commander";
import { z } from "zod";
import { toErrorMessage, WaldError } from "../../domain/errors.js";
import type { Worktree } from "../../domain/types.js";
import { builtInToolNames } from "../../services/tool-service.js";
import type { CreatedWorktree, CreatePlan } from "../../services/worktree-workflow-service.js";
import { type CreateDestination, printCreatePlan } from "../../ui/create-plan.js";
import { style } from "../../ui/style.js";
import { isPromptBackError, promptText, runTask, selectValue } from "../../ui/terminal.js";
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
    skipHooks: z.boolean().default(false),
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

export type CreateInput = Omit<z.output<typeof createInputSchema>, "json" | "skipHooks"> & {
  json?: boolean;
  skipHooks?: boolean;
};

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
    .option("--skip-hooks", "Skip all pre_create and post_create steps, including copy and symlink")
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
          skipHooks?: unknown;
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
  input = { ...input };
  const workspace = await context.workspaces.find();
  const promptedForBranch = input.branch === undefined;
  const branchState: { selectedValue?: string; branchValue?: string } = {};
  let plan: CreatePlan;
  while (true) {
    const branch =
      input.branch ??
      (input.carry
        ? await chooseNewBranch("Handoff › New branch · Branch name:", branchState, (value) =>
            context.worktrees.validateBranch(workspace, value),
          )
        : await chooseBranch(workspace, context.worktrees, branchState));
    plan = await prepareCreatePlan(workspace, branch, input, context);
    if (!promptedForBranch) break;
    try {
      const reviewed = await reviewCreatePlan(plan, input, context);
      if (reviewed) {
        plan = reviewed;
        break;
      }
      writeLine(context.output.stdout, createCancellationMessage(plan));
      return null;
    } catch (error) {
      if (isPromptBackError(error)) continue;
      throw error;
    }
  }
  if (!plan.skipHooks) {
    await ensureTrusted(workspace, plan.project, context, { nonInteractive: input.json });
  }
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
      skipHooks: input.skipHooks,
    });
  return input.json ? await prepare() : await runTask("Preparing worktree", prepare);
}

async function reviewCreatePlan(
  plan: CreatePlan,
  input: CreateInput,
  context: CliContext,
): Promise<CreatePlan | null> {
  while (true) {
    printCreatePlan(plan, createDestination(input), context.output);
    const action = await selectValue(
      "Create › Review · Ready to create?",
      [
        { label: "Create worktree", value: "create" },
        {
          label: "Change options…",
          value: "options",
          description: "Directory, base branch, setup, and opening.",
        },
        { label: "Cancel", value: "cancel" },
      ],
      { navigation: "back", initialValue: "create" },
    );
    if (action === "create") return plan;
    if (action === "cancel") return null;
    try {
      plan = await changeCreateOptions(plan, input, context);
    } catch (error) {
      if (!isPromptBackError(error)) throw error;
    }
  }
}

async function changeCreateOptions(
  plan: CreatePlan,
  input: CreateInput,
  context: CliContext,
): Promise<CreatePlan> {
  while (true) {
    const canChangeBase = plan.prepared.strategy.type === "new" && !input.carry;
    let action: string;
    try {
      action = await selectValue(
        "Create › Options · What would you like to change?",
        [
          ...(canChangeBase ? [{ label: "Base branch or commit", value: "base" }] : []),
          { label: "Worktree directory name", value: "name" },
          {
            label: "Run or skip create hooks",
            value: "hooks",
            description: "Includes configured copy and symlink steps.",
          },
          { label: "After creation", value: "destination" },
          { label: "Back to preview", value: "back" },
        ],
        { navigation: "back" },
      );
    } catch (error) {
      if (isPromptBackError(error)) return plan;
      throw error;
    }
    if (action === "back") return plan;
    const next = { ...input };
    try {
      if (action === "base" || action === "name") {
        const key = action === "base" ? "from" : "name";
        const value = await promptText(
          action === "base"
            ? "Create › Base · Branch or commit (empty: configured default):"
            : "Create › Directory · Directory name (empty: generated from branch):",
          action === "base"
            ? (input.from ??
                (plan.prepared.strategy.type === "new" ? plan.prepared.strategy.base : undefined))
            : (input.name ?? path.basename(plan.prepared.target)),
          {
            navigation: "back",
            validateAsync: async (value) => {
              await prepareCreatePlan(
                plan.workspace,
                plan.prepared.branch,
                { ...input, [key]: value || undefined, fetch: false },
                context,
              );
            },
          },
        );
        next[key] = value || undefined;
      } else if (action === "hooks") {
        next.skipHooks =
          (await selectValue(
            "Create › Setup · Run configured create hooks?",
            [
              { label: "Run hooks", value: "run" },
              { label: "Skip hooks, including copy and symlink", value: "skip" },
            ],
            { navigation: "back", initialValue: input.skipHooks ? "skip" : "run" },
          )) === "skip";
      } else if (action === "destination") {
        const destination = await selectValue(
          "Create › Destination · After creation:",
          [
            { label: "Stay here and show navigation commands", value: "stay" },
            { label: "Open in an editor or agent", value: "open" },
          ],
          { navigation: "back", initialValue: input.open || input.tool ? "open" : "stay" },
        );
        next.cd = false;
        next.open = destination === "open";
        if (!next.open) next.tool = undefined;
      }
      const updated = await prepareCreatePlan(
        plan.workspace,
        plan.prepared.branch,
        { ...next, fetch: false },
        context,
      );
      updated.fetchedRemote = plan.fetchedRemote;
      Object.assign(input, next);
      plan = updated;
    } catch (error) {
      if (isPromptBackError(error)) continue;
      throw error;
    }
  }
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
