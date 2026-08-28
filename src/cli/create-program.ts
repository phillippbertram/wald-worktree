import { Command } from "commander";
import pc from "picocolors";
import { registerCdCommand } from "./commands/cd.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerCreateCommand } from "./commands/create.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerHandoffCommand } from "./commands/handoff.js";
import { registerHookCommand } from "./commands/hook.js";
import { registerInitCommand } from "./commands/init.js";
import { registerListCommand } from "./commands/list.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerPruneCommand } from "./commands/prune.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerRenameCommand } from "./commands/rename.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerStatusCommand } from "./commands/status.js";
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
    .version("0.10.0")
    .showSuggestionAfterError()
    .showHelpAfterError()
    .configureHelp({
      styleTitle: (text) => pc.cyan(pc.bold(text)),
      styleCommandText: (text) => pc.green(pc.bold(text)),
      styleSubcommandText: (text) => pc.green(text),
      styleOptionText: (text) => pc.yellow(text),
      styleArgumentText: (text) => pc.magenta(text),
    });

  program.addHelpText(
    "after",
    `\n${pc.cyan(pc.bold("🌱 Start here:"))}\n  ${pc.green("cd ~/dev/project && ygg init")}\n  ${pc.green("ygg create feature/payment --cd")}\n  ${pc.green("ygg create feature/review --tool codex")}\n`,
  );

  program.configureOutput({
    writeOut: (text) => output.stdout.write(text),
    writeErr: (text) => output.stderr.write(text),
  });
  program.action(async () => runMainMenu(program, context));

  registerInitCommand(program, context);
  registerCreateCommand(program, context);
  registerHandoffCommand(program, context);
  registerStatusCommand(program, context);
  registerListCommand(program, context);
  registerCdCommand(program, context);
  registerOpenCommand(program, context);
  registerExecCommand(program, context);
  registerRunCommand(program, context);
  registerHookCommand(program, context);
  registerSetupCommand(program, context);
  registerRenameCommand(program, context);
  registerRemoveCommand(program, context);
  registerPruneCommand(program, context);
  registerUninitCommand(program, context);
  registerConfigCommand(program, context);
  registerCompletionCommand(program, context);

  return program;
}
