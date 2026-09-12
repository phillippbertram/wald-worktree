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

export type HandoffInput = Omit<z.output<typeof handoffInputSchema>, "json"> & { json?: boolean };

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
    .option("--json", "Emit machine-readable JSON without prompting")
    .addOption(new Option("--print-path").hideHelp())
    .addHelpText(
      "after",
      `\nThis transfers code state only. It does not move a running editor, process, or agent session.\n\nBuilt-in tools: ${builtInToolNames.join(", ")}\n\nExamples:\n  wald handoff feature/payment --cd\n  wald handoff feature/review --tool codex\n`,
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
          json?: unknown;
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
