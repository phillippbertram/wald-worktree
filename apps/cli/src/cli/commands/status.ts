import type { Command } from "commander";
import { z } from "zod";
import { printWorkspaceStatus } from "../../ui/status.js";
import { runTask } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { writeJson } from "../helpers.js";
import { parseCliInput } from "../input.js";

const statusInputSchema = z.object({ json: z.boolean().default(false) }).strict();
export type StatusInput = z.output<typeof statusInputSchema>;

export function registerStatusCommand(program: Command, context: CliContext): void {
  program
    .command("status")
    .description("Show the current Wald workspace and worktree status")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: unknown) => {
      await showWorkspaceStatus(parseCliInput(statusInputSchema, options), context);
    });
}

export async function showWorkspaceStatus(input: StatusInput, context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  const status = await runTask("Reading workspace status", () => context.status.inspect(workspace));
  if (input.json) writeJson(context.output.stdout, status);
  else printWorkspaceStatus(status, context.output.stdout);
}
