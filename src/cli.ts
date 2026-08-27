#!/usr/bin/env node

import { CommanderError } from "commander";
import pc from "picocolors";
import { createProgram } from "./cli/create-program.js";
import { toErrorMessage, YggError } from "./domain/errors.js";
import { redactSensitiveText, sanitizeTerminalText } from "./infrastructure/safe-text.js";
import { isPromptBackError } from "./ui/terminal.js";

async function main(): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (isPromptBackError(error)) return;
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }

    if (error instanceof YggError && error.exitCode === 130) {
      process.exitCode = 130;
      return;
    }

    const message = sanitizeTerminalText(redactSensitiveText(toErrorMessage(error)), {
      multiline: true,
    });
    process.stderr.write(`${pc.red(pc.bold("Error:"))} ${message}\n`);
    process.exitCode = error instanceof YggError ? error.exitCode : 1;
  }
}

await main();
