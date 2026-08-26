import { checkbox, input, confirm as inquirerConfirm, search, select } from "@inquirer/prompts";
import ora from "ora";
import pc from "picocolors";
import type { Worktree } from "../domain/types.js";

type Choice = {
  label: string;
  value: string;
  description?: string;
  checked?: boolean;
};

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function runTask<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!isInteractiveTerminal()) {
    return await task();
  }

  const spinner = ora({ text: label, stream: process.stderr }).start();
  try {
    const result = await task();
    spinner.stop();
    return result;
  } catch (error) {
    spinner.stop();
    throw error;
  }
}

export async function confirm(question: string, defaultValue = false): Promise<boolean> {
  return (
    (await promptOrNull(() =>
      inquirerConfirm({
        message: question,
        default: defaultValue,
      }),
    )) ?? false
  );
}

export async function selectWorktree(worktrees: Worktree[]): Promise<Worktree | null> {
  const selectedPath = await searchSelect(
    "Select a worktree:",
    worktrees.map((worktree) => ({
      label: `${worktree.name}  ${worktree.branch ?? "detached"}`,
      value: worktree.path,
      description: `${worktree.role}, ${worktree.state}`,
    })),
  );
  return worktrees.find((worktree) => worktree.path === selectedPath) ?? null;
}

export async function selectValue(question: string, options: Choice[]): Promise<string | null> {
  return await promptOrNull(() =>
    select({
      message: question,
      choices: options.map(toInquirerChoice),
      pageSize: 10,
    }),
  );
}

export async function searchSelect(question: string, options: Choice[]): Promise<string | null> {
  return await promptOrNull(() =>
    search({
      message: question,
      pageSize: 10,
      source: (term) => {
        const normalized = term?.trim().toLocaleLowerCase() ?? "";
        return options
          .filter((option) =>
            `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(normalized),
          )
          .map(toInquirerChoice);
      },
    }),
  );
}

export async function selectManyValues(question: string, options: Choice[]): Promise<string[]> {
  return (
    (await promptOrNull(() =>
      checkbox({
        message: question,
        choices: options.map((option) => ({
          ...toInquirerChoice(option),
          checked: option.checked,
        })),
        pageSize: 10,
      }),
    )) ?? []
  );
}

export async function selectManyWorktrees(
  question: string,
  worktrees: Worktree[],
): Promise<Worktree[]> {
  const selectedPaths = await selectManyValues(
    question,
    worktrees.map((worktree) => ({
      label: `${worktree.name}  ${worktree.branch ?? "detached"}`,
      value: worktree.path,
      description: worktree.state,
    })),
  );
  return worktrees.filter((worktree) => selectedPaths.includes(worktree.path));
}

export async function promptText(question: string, defaultValue?: string): Promise<string> {
  return (
    (
      await promptOrNull(() =>
        input({
          message: question,
          default: defaultValue,
        }),
      )
    )?.trim() ?? ""
  );
}

export async function printWorktreeTable(worktrees: Worktree[]): Promise<void> {
  printTable(
    ["NAME", "BRANCH", "ROLE", "STATUS", "PATH"],
    worktrees.map((worktree) => [
      worktree.name,
      worktree.branch ?? "detached",
      worktree.role,
      worktree.state,
      worktree.path,
    ]),
    (cell, column, row) => {
      if (column === 0) return pc.bold(cell);
      if (column === 3) return colorState(cell, worktrees[row]?.state);
      return cell;
    },
  );
}

export async function printKeyValueTable(rows: Array<[string, string]>): Promise<void> {
  printTable(["SETTING", "VALUE"], rows, (cell, column) =>
    column === 0 ? pc.cyan(pc.bold(cell)) : cell,
  );
}

export async function printStatus(
  variant: "success" | "error" | "warning" | "info",
  message: string,
): Promise<void> {
  const symbol = {
    success: pc.green("✔"),
    error: pc.red("✖"),
    warning: pc.yellow("⚠"),
    info: pc.cyan("ℹ"),
  }[variant];
  process.stdout.write(`${symbol} ${message}\n`);
}

function printTable(
  headers: string[],
  rows: string[][],
  formatCell: (cell: string, column: number, row: number) => string = (cell) => cell,
): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (row: string[], rowIndex: number, header = false): string =>
    row
      .map((cell, column) => {
        const padded = cell.padEnd(
          (widths[column] ?? cell.length) + (column === row.length - 1 ? 0 : 2),
        );
        return header ? pc.cyan(pc.bold(padded)) : formatCell(padded, column, rowIndex);
      })
      .join("");

  process.stdout.write(`${render(headers, -1, true)}\n`);
  for (const [index, row] of rows.entries()) {
    process.stdout.write(`${render(row, index)}\n`);
  }
}

function colorState(value: string, state: Worktree["state"] | undefined): string {
  switch (state) {
    case "clean":
      return pc.green(value);
    case "modified":
      return pc.yellow(value);
    case "locked":
    case "missing":
      return pc.red(value);
    default:
      return value;
  }
}

function toInquirerChoice(option: Choice): {
  name: string;
  value: string;
  description?: string;
} {
  return {
    name: option.label,
    value: option.value,
    description: option.description,
  };
}

async function promptOrNull<T>(prompt: () => Promise<T>): Promise<T | null> {
  try {
    return await prompt();
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return null;
    }
    throw error;
  }
}
