import { type Command, Option } from "commander";
import { z } from "zod";
import { toErrorMessage, WtError } from "../../domain/errors.js";
import type { Worktree } from "../../domain/types.js";
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
  .strict();

export type CreateInput = z.output<typeof createInputSchema>;

export function registerCreateCommand(program: Command, context: CliContext): void {
  program
    .command("create")
    .description("Create a worktree for an existing or new branch")
    .argument("[branch]", "Branch to check out or create")
    .option("--from <commit-ish>", "Base for a new branch")
    .option("--name <directory>", "Override the worktree directory name")
    .option("--fetch", "Fetch before resolving the branch")
    .option("--no-fetch", "Do not fetch before resolving the branch")
    .option("--cd", "Enter the created worktree when shell integration is enabled")
    .option("--open", "Open the created worktree in an editor or agent")
    .option("--tool <profile>", "Tool profile to open; implies --open")
    .addOption(new Option("--print-path").hideHelp())
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
      throw new WtError(
        `Worktree was created at ${created.path}, but opening it failed: ${toErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  if (input.printPath) {
    writeLine(context.output.stdout, created.path);
  } else {
    await success(`Created ${created.name} at ${created.path}`, context.output);
    writeLine(
      context.output.stdout,
      input.cd
        ? "Shell integration will enter the new worktree."
        : `Next: wt cd ${shellQuote(created.name)}`,
    );
  }
  return created;
}
