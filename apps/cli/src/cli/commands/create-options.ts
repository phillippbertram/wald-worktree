import { type Command, Option } from "commander";
import { z } from "zod";
import { optionValueIfExplicit } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

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

export function configureCreateCommand(
  command: Command,
  run: (input: CreateInput) => Promise<unknown>,
): void {
  command
    .option("--name <directory>", "Override the worktree directory name")
    .option("--fetch", "Fetch before resolving the branch")
    .option("--no-fetch", "Do not fetch before resolving the branch")
    .option("--skip-hooks", "Skip all pre_create and post_create steps, including copy and symlink")
    .option("--cd", "Enter the new worktree; requires shell integration")
    .option("--open", "Open the new worktree with the configured or selected tool")
    .option("--tool <profile>", "Tool profile to open; implies --open")
    .option("--json", "Emit machine-readable JSON without prompting")
    .addOption(new Option("--print-path").hideHelp())
    .action(async (branch: unknown, options: Record<string, unknown>, command: Command) => {
      await run(
        parseCliInput(createInputSchema, {
          branch,
          ...options,
          fetch: optionValueIfExplicit(command, "fetch", options.fetch),
        }),
      );
    });
}
