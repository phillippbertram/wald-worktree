import fs from "node:fs/promises";
import path from "node:path";
import { WaldError } from "../domain/errors.js";

export async function resolveWorkingDirectory(
  directories: string[],
  initialDirectory = process.cwd(),
): Promise<string> {
  let directory = initialDirectory;
  for (const requested of directories) {
    try {
      const resolved = await fs.realpath(path.resolve(directory, requested));
      if (!(await fs.stat(resolved)).isDirectory()) {
        throw new WaldError(`Cannot use directory ${requested}: not a directory.`);
      }
      directory = resolved;
    } catch (error) {
      if (error instanceof WaldError) throw error;
      throw new WaldError(
        `Cannot use directory ${requested}: directory does not exist or cannot be accessed.`,
        { cause: error },
      );
    }
  }
  return directory;
}

export async function enterWorkingDirectory(directories: string[]): Promise<void> {
  if (directories.length === 0) return;
  const directory = await resolveWorkingDirectory(directories);
  try {
    process.chdir(directory);
  } catch (error) {
    throw new WaldError(`Cannot enter directory ${directory}.`, { cause: error });
  }
}
