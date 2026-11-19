import { Command, type ErrorOptions } from "commander";
import pc from "picocolors";
import manifest from "../../package.json" with { type: "json" };
import { WaldError } from "../domain/errors.js";
import { registerCdCommand } from "./commands/cd.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerCreateCommand } from "./commands/create.js";
import { registerDoctorCommand } from "./commands/doctor.js";
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
import {
  type CliExecutionState,
  type CliOutput,
  createCliContext,
  createCliExecutionState,
} from "./context.js";
import { applyDirectories, collectDirectories } from "./directory-option.js";
import { inspectInvocation } from "./invocation.js";
import { runMainMenu } from "./main-menu.js";

class WaldCommand extends Command {
  constructor(
    name: string,
    private readonly execution: CliExecutionState,
  ) {
    super(name);
  }

  override createCommand(name = ""): Command {
    return new WaldCommand(name, this.execution);
  }

  override parseOptions(argv: string[]) {
    if (!this.parent) Object.assign(this.execution, inspectInvocation(this, argv));
    return super.parseOptions(argv);
  }

  override error(message: string, options?: ErrorOptions): never {
    if (this.execution.json || this.optsWithGlobals().json === true) {
      this.execution.json = true;
      throw new WaldError(message, { exitCode: options?.exitCode });
    }
    return super.error(message, options);
  }
}

export function createProgram(
  output: CliOutput = { stdout: process.stdout, stderr: process.stderr },
  execution: CliExecutionState = createCliExecutionState(),
): Command {
  const context = createCliContext(output, execution);
  const program = new WaldCommand("wald", execution)
    .description("🌲 Where Git worktrees grow — safe, guided workspaces for parallel work.")
    .version(manifest.version)
    .option("--no-input", "Disable wald prompts and require explicit inputs")
    .option(
      "-C, --directory <path>",
      "Run from this directory; repeat to resolve paths in order",
      collectDirectories,
    )
    .showSuggestionAfterError()
    .showHelpAfterError()
    .configureHelp({
      showGlobalOptions: true,
      styleTitle: (text) => pc.cyan(pc.bold(text)),
      styleCommandText: (text) => pc.green(pc.bold(text)),
      styleSubcommandText: (text) => pc.green(text),
      styleOptionText: (text) => pc.yellow(text),
      styleArgumentText: (text) => pc.magenta(text),
    });

  program.addHelpText(
    "after",
    `\n${pc.cyan(pc.bold("🌱 Start here:"))}\n  ${pc.green("cd ~/dev/project && wald init")}\n  ${pc.green("wald -C ~/dev/project status")}\n  ${pc.green("wald create feature/payment --cd")}\n  ${pc.green("wald create feature/review --tool codex")}\n`,
  );

  program.configureOutput({
    writeOut: (text) => output.stdout.write(text),
    writeErr: (text) => output.stderr.write(text),
  });
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    execution.noInput = program.opts().input === false;
    execution.json = actionCommand.optsWithGlobals().json === true;
    await applyDirectories(program.opts().directory);
  });
  program.action(async () => runMainMenu(program, context));

  registerInitCommand(program, context);
  registerCreateCommand(program, context);
  registerHandoffCommand(program, context);
  registerDoctorCommand(program, context);
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
