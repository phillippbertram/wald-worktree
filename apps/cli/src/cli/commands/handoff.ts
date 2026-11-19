import type { Command } from "commander";
import { builtInToolNames } from "../../services/tool-service.js";
import type { CliContext } from "../context.js";
import { createWorktree } from "./create.js";
import { type CreateInput, configureCreateCommand } from "./create-options.js";

export function registerHandoffCommand(program: Command, context: CliContext): void {
  const command = program
    .command("handoff")
    .description("Carry local code changes into a new worktree without moving an agent session")
    .argument("[branch]", "New branch for the handed-off code")
    .addHelpText(
      "after",
      `\nThis transfers code state only. It does not move a running editor, process, or agent session.\n\nBuilt-in tools: ${builtInToolNames.join(", ")}\n\nExamples:\n  wald handoff feature/payment --cd\n  wald handoff feature/review --tool codex\n`,
    );
  configureCreateCommand(command, (input) => handoffWorktree(input, context));
}

export async function handoffWorktree(
  input: Omit<CreateInput, "from" | "carry">,
  context: CliContext,
) {
  return await createWorktree({ ...input, carry: true }, context);
}
