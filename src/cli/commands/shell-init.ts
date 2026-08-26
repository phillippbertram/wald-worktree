import type { Command } from "commander";
import { z } from "zod";
import type { CliContext } from "../context.js";
import { parseCliInput } from "../input.js";

const shellInputSchema = z.object({ shell: z.enum(["bash", "zsh", "fish"]) }).strict();

export function registerShellInitCommand(program: Command, context: CliContext): void {
  program
    .command("shell-init")
    .description("Print shell navigation and completion integration")
    .argument("<shell>", "bash, zsh, or fish")
    .addHelpText(
      "after",
      '\nExample for zsh:\n  eval "$(wt shell-init zsh)"\n\nAdd the same line to ~/.zshrc for permanent integration.\n',
    )
    .action((shell: unknown) => {
      const input = parseCliInput(shellInputSchema, { shell });
      context.output.stdout.write(context.shells.render(input.shell));
    });
}
