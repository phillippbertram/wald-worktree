import type { Command, Option } from "commander";

export type CompletionRequest = {
  args: string[];
  directories: string[];
  directoryInput?: { value: string; prefix: string };
  afterSeparator?: boolean;
};

export function parseCompletionRequest(args: string[], program: Command): CompletionRequest {
  const result: CompletionRequest = { args: [], directories: [] };
  let command = program;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (token === "--" && index < args.length - 1) {
      result.args.push(...args.slice(index));
      result.afterSeparator = true;
      break;
    }
    if (token === "-C" || token === "--directory") {
      const value = args[index + 1];
      if (value !== undefined) {
        if (index + 1 === args.length - 1) {
          result.directoryInput = { value, prefix: "" };
          return result;
        }
        result.directories.push(value);
        index += 1;
        continue;
      }
    }
    const prefix = token.startsWith("--directory=")
      ? "--directory="
      : token.startsWith("-C") && token.length > 2
        ? "-C"
        : undefined;
    if (prefix) {
      const value = token.slice(prefix.length);
      if (index === args.length - 1) {
        result.directoryInput = { value, prefix };
        return result;
      }
      result.directories.push(value);
      continue;
    }
    result.args.push(token);
    if (token.startsWith("-")) {
      const option = findOption(command, token.split("=", 1)[0] ?? token);
      if (option?.required && !token.includes("=") && args[index + 1] !== undefined) {
        result.args.push(args[index + 1] as string);
        index += 1;
      }
    } else {
      command =
        command.commands.find(
          (child) => child.name() === token || child.aliases().includes(token),
        ) ?? command;
    }
  }
  return result;
}

function findOption(command: Command, token: string): Option | undefined {
  return (
    command.options.find((option) => option.short === token || option.long === token) ??
    (command.parent ? findOption(command.parent, token) : undefined)
  );
}
