import { Command } from "commander";
import { registerCdCommand } from "./commands/cd.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerCreateCommand } from "./commands/create.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerInitCommand } from "./commands/init.js";
import { registerListCommand } from "./commands/list.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerPruneCommand } from "./commands/prune.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerUninitCommand } from "./commands/uninit.js";
import { type CliOutput, createCliContext } from "./context.js";
import { runMainMenu } from "./main-menu.js";

export function createProgram(
  output: CliOutput = { stdout: process.stdout, stderr: process.stderr },
): Command {
  const context = createCliContext(output);
  const program = new Command()
    .name("ygg")
    .description("🌳 Create and work in isolated Git checkouts safely.")
    .version("1.0.0")
    .showSuggestionAfterError()
    .showHelpAfterError();

  program.addHelpText(
    "after",
    "\n🌱 Start here:\n  cd ~/dev/project && ygg init\n  ygg create feature/payment --cd\n  ygg create feature/review --tool codex\n",
  );

  program.configureOutput({
    writeOut: (text) => output.stdout.write(text),
    writeErr: (text) => output.stderr.write(text),
  });
  program.action(async () => runMainMenu(program, context));

  registerInitCommand(program, context);
  registerCreateCommand(program, context);
  registerListCommand(program, context);
  registerCdCommand(program, context);
  registerOpenCommand(program, context);
  registerExecCommand(program, context);
  registerRunCommand(program, context);
  registerSetupCommand(program, context);
  registerRemoveCommand(program, context);
  registerPruneCommand(program, context);
  registerUninitCommand(program, context);
  registerConfigCommand(program, context);
  registerCompletionCommand(program, context);

  return program;
}
