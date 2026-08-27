import { type Command, Option } from "commander";
import { z } from "zod";
import { builtInToolNames } from "../../services/tool-service.js";
import type { CliContext } from "../context.js";
import { optionValueIfExplicit } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";
import { createWorktree } from "./create.js";

const handoffInputSchema = z
  .object({
    branch: nonEmptyCliString.optional(),
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

export type HandoffInput = z.output<typeof handoffInputSchema>;

export function registerHandoffCommand(program: Command, context: CliContext): void {
  program
    .command("handoff")
    .description("Carry local code changes into a new worktree without moving an agent session")
    .argument("[branch]", "New branch for the handed-off code")
    .option("--name <directory>", "Override the worktree directory name")
    .option("--fetch", "Fetch before checking that the new branch name is available")
    .option("--no-fetch", "Do not fetch before checking the new branch name")
    .option("--cd", "Enter after handoff; requires shell integration")
    .option("--open", "Open after handoff with the configured or selected tool")
    .option("--tool <profile>", "Tool profile to open; implies --open")
    .addOption(new Option("--print-path").hideHelp())
    .addHelpText(
      "after",
      `\nThis transfers code state only. It does not move a running editor, process, or agent session.\n\nBuilt-in tools: ${builtInToolNames.join(", ")}\n\nExamples:\n  ygg handoff feature/payment --cd\n  ygg handoff feature/review --tool codex\n`,
    )
    .action(
      async (
        branch: unknown,
        options: {
          name?: unknown;
          fetch?: boolean;
          cd?: unknown;
          open?: unknown;
          tool?: unknown;
          printPath?: unknown;
        },
        command: Command,
      ) => {
        const input = parseCliInput(handoffInputSchema, {
          branch,
          ...options,
          fetch: optionValueIfExplicit(command, "fetch", options.fetch),
        });
        await handoffWorktree(input, context);
      },
    );
}

export async function handoffWorktree(input: HandoffInput, context: CliContext) {
  return await createWorktree({ ...input, carry: true }, context);
}
