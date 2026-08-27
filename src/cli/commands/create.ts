import { type Command, Option } from "commander";
import { z } from "zod";
import { toErrorMessage, YggError } from "../../domain/errors.js";
import type { Worktree } from "../../domain/types.js";
import { builtInToolNames } from "../../services/tool-service.js";
import { runTask } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import {
  chooseBranch,
  ensureTrusted,
  optionValueIfExplicit,
  shellQuote,
  success,
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
    cd: z.boolean().default(false),
    open: z.boolean().default(false),
    tool: nonEmptyCliString.optional(),
    printPath: z.boolean().default(false),
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
  });

export type CreateInput = z.output<typeof createInputSchema>;

export function registerCreateCommand(program: Command, context: CliContext): void {
  program
    .command("create")
    .description("Create and prepare a worktree for an existing or new branch")
    .argument("[branch]", "Branch to check out or create")
    .option("--from <commit-ish>", "Base commit for a new branch only")
    .option("--name <directory>", "Override the worktree directory name")
    .option("--fetch", "Fetch before resolving the branch")
    .option("--no-fetch", "Do not fetch before resolving the branch")
    .option("--cd", "Enter after creation; requires shell integration")
    .option("--open", "Open after creation with the configured or selected tool")
    .option("--tool <profile>", "Tool profile to open; implies --open")
    .addOption(new Option("--print-path").hideHelp())
    .addHelpText(
      "after",
      `\nBuilt-in tools: ${builtInToolNames.join(", ")}\n\nExamples:\n  ygg create feature/payment --cd\n  ygg create hotfix/payment --from release/1.x --cd\n  ygg create feature/review --tool codex\n`,
    )
    .action(
      async (
        branch: unknown,
        options: {
          from?: unknown;
          name?: unknown;
          fetch?: boolean;
          cd?: unknown;
          open?: unknown;
          tool?: unknown;
          printPath?: unknown;
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

export async function createWorktree(input: CreateInput, context: CliContext): Promise<Worktree> {
  const workspace = await context.workspaces.find();
  const branch = input.branch ?? (await chooseBranch(workspace, context.worktrees));
  const plan = await runTask("Preparing worktree", () =>
    context.workflow.planCreate(workspace, {
      branch,
      from: input.from,
      name: input.name,
      fetch: input.fetch,
    }),
  );
  await ensureTrusted(workspace, plan.project, context);
  const created = await context.workflow.executeCreate(plan, {
    output: context.output.stderr,
  });

  if (input.open || input.tool) {
    try {
      await openSelectedWorktree(created, input.tool, context, {
        silent: input.printPath,
        project: await context.workflow.projectForWorktree(created),
      });
    } catch (error) {
      throw new YggError(
        `Worktree was created at ${created.path}, but opening it failed: ${toErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  if (input.printPath) {
    writeLine(context.output.stdout, created.path);
  } else {
    await success(`Created ${created.name} at ${created.path}`, context.output);
    if (input.cd) {
      writeLine(
        context.output.stdout,
        `Shell integration is not active for this invocation. Enter with: cd ${shellQuote(created.path)}`,
      );
    } else if (!input.open && !input.tool) {
      writeLine(context.output.stdout, `Next: ygg cd ${shellQuote(created.name)}`);
      writeLine(context.output.stdout, `Without shell integration: cd ${shellQuote(created.path)}`);
    }
  }
  return created;
}
