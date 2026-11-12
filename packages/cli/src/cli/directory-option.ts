import { z } from "zod";
import { enterWorkingDirectory } from "../infrastructure/working-directory.js";
import { nonEmptyCliString, parseCliInput } from "./input.js";

export function collectDirectories(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export async function applyDirectories(values: unknown): Promise<void> {
  const { directory } = parseCliInput(
    z.object({ directory: z.array(nonEmptyCliString).default([]) }),
    { directory: values },
  );
  await enterWorkingDirectory(directory);
}
