import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeTerminalText } from "./safe-text.js";

export async function completeDirectories(value: string): Promise<string[]> {
  if (sanitizeTerminalText(value) !== value) return [];
  const slash = value.lastIndexOf("/");
  const prefix = slash < 0 ? "" : value.slice(0, slash + 1);
  const partial = value.slice(slash + 1);
  try {
    const entries = await fs.readdir(path.resolve(prefix || "."), { withFileTypes: true });
    const directories = await Promise.all(
      entries.map(async (entry) => {
        if (!entry.name.startsWith(partial) || sanitizeTerminalText(entry.name) !== entry.name)
          return null;
        if (entry.name.startsWith(".") && !partial.startsWith(".")) return null;
        const candidate = `${prefix}${entry.name}`;
        const isDirectory =
          entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            (await fs.stat(path.resolve(candidate)).then(
              (stat) => stat.isDirectory(),
              () => false,
            )));
        return isDirectory ? `${candidate}/` : null;
      }),
    );
    return directories.filter((directory): directory is string => directory !== null).sort();
  } catch {
    return [];
  }
}
