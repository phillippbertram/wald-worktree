import path from "node:path";

export const projectRoot = path.resolve(import.meta.dirname, "../..");
const binary = process.env.WALD_TEST_BINARY;
if (binary !== undefined && (!binary || !path.isAbsolute(binary))) {
  throw new Error("WALD_TEST_BINARY must be an absolute path to the executable under test.");
}

export const cliExecutable = binary ?? process.execPath;

export function cliArguments(...args: string[]): string[] {
  return binary
    ? args
    : ["--import", import.meta.resolve("tsx"), path.join(projectRoot, "src/cli.ts"), ...args];
}
