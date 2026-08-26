#!/usr/bin/env node

import { CommanderError } from "commander";
import { createProgram } from "./cli/create-program.js";
import { toErrorMessage, WtError } from "./domain/errors.js";

async function main(): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }

    process.stderr.write(`Error: ${toErrorMessage(error)}\n`);
    process.exitCode = error instanceof WtError ? error.exitCode : 1;
  }
}

await main();
