#!/usr/bin/env node

import { CommanderError } from "commander";
import pc from "picocolors";
import { createCliExecutionState } from "./cli/context.js";
import { createProgram } from "./cli/create-program.js";
import { toErrorMessage, WaldError } from "./domain/errors.js";
import { redactSensitiveText, sanitizeTerminalText } from "./infrastructure/safe-text.js";
import { isPromptBackError } from "./ui/terminal.js";

async function main(): Promise<void> {
  const execution = createCliExecutionState();
  const program = createProgram(undefined, execution);
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (isPromptBackError(error)) return;
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }

    if (error instanceof WaldError && error.exitCode === 130) {
      process.exitCode = 130;
      return;
    }

    const message = sanitizeTerminalText(redactSensitiveText(toErrorMessage(error)), {
      multiline: true,
    });
    const exitCode = error instanceof WaldError ? error.exitCode : 1;
    if (execution.json) {
      process.stderr.write(
        `${JSON.stringify({
          message,
          exitCode,
          ...(error instanceof WaldError && error.effects !== undefined
            ? { effects: error.effects }
            : {}),
        })}\n`,
      );
    } else {
      process.stderr.write(`${pc.red(pc.bold("Error:"))} ${message}\n`);
    }
    process.exitCode = exitCode;
  }
}

await main();
