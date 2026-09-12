import { z } from "zod";
import { WaldError } from "../domain/errors.js";

export const nonEmptyCliString = z.string().min(1, "Cannot be empty.");

export function parseCliInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues.map((issue) => {
    const field = issue.path.length > 0 ? formatField(issue.path.join(".")) : "command";
    return `- ${field}: ${issue.message}`;
  });
  throw new WaldError(`Invalid command input:\n${details.join("\n")}\nRun with --help for usage.`);
}

function formatField(field: string): string {
  if (
    ["repository", "directory", "branch", "worktree", "worktrees", "task", "command"].includes(
      field,
    )
  ) {
    return field;
  }
  return `--${field.replaceAll(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)}`;
}
