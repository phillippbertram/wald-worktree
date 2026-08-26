import type { Command } from "commander";
import { z } from "zod";
import type { CliContext } from "../context.js";
import { parseCliInput } from "../input.js";

const shellInputSchema = z.object({ shell: z.enum(["bash", "zsh", "fish"]) }).strict();

export function registerShellInitCommand(program: Command, context: CliContext): void {
  program
    .command("shell-init")
    .description("Generate shell navigation and completion integration")
    .argument("<shell>", "bash, zsh, or fish")
    .action((shell: unknown) => {
      const input = parseCliInput(shellInputSchema, { shell });
      context.output.stdout.write(context.shells.render(input.shell));
    });
}
