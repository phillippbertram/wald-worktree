import type { Command, Option } from "commander";

export function findOption(command: Command, token: string): Option | undefined {
  return (
    command.options.find((option) => option.short === token || option.long === token) ??
    (command.parent ? findOption(command.parent, token) : undefined)
  );
}

// Capture intent that Commander loses while processing the parent and child separately:
// the output mode for early parse errors, and an omitted worktree before exec's separator.
export function inspectInvocation(program: Command, args: string[]) {
  let command = program;
  let operands = 0;
  let json = false;
  let implicitExecCommand: string[] | undefined;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined) break;
    if (token === "--") {
      if (command.name() === "exec" && operands === 0) implicitExecCommand = args.slice(index + 1);
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      const option = findOption(command, token);
      if (option?.long === "--json") json = true;
      const next = args[index + 1];
      if (option?.required || (option?.optional && next !== undefined && !next.startsWith("-")))
        index++;
      continue;
    }
    const child =
      operands === 0 &&
      command.commands.find((child) => child.name() === token || child.aliases().includes(token));
    if (child) command = child;
    else operands++;
  }
  return { json, implicitExecCommand };
}
