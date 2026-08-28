import {
  checkbox,
  input,
  confirm as inquirerConfirm,
  Separator,
  search,
  select,
} from "@inquirer/prompts";
import ora from "ora";
import pc from "picocolors";
import { YggError } from "../domain/errors.js";
import type { Worktree } from "../domain/types.js";
import { style } from "./style.js";

type Choice = {
  label: string;
  value: string;
  description?: string;
  checked?: boolean;
  group?: string;
};

export type PromptNavigation = "back" | "cancel" | "exit";

type PromptOptions = {
  navigation?: PromptNavigation;
  initialValue?: string;
  initialValues?: string[];
};

export class PromptBackError extends Error {
  constructor() {
    super("Interactive prompt went back.");
    this.name = "PromptBackError";
  }
}

export class PromptExitError extends YggError {
  constructor(options?: { cause?: unknown }) {
    super("Interactive prompt was interrupted.", { ...options, exitCode: 130 });
    this.name = "PromptExitError";
  }
}

export function isPromptBackError(error: unknown): error is PromptBackError {
  return error instanceof PromptBackError;
}

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

export async function confirm(
  question: string,
  defaultValue = false,
  _options: PromptOptions = {},
): Promise<boolean> {
  return await promptWithNavigation((signal) =>
    inquirerConfirm(
      {
        message: question,
        default: defaultValue,
      },
      { signal },
    ),
  );
}

export async function selectWorktree(
  worktrees: Worktree[],
  options: PromptOptions = {},
): Promise<Worktree | null> {
  const selectedPath = await searchSelect(
    "Select a worktree:",
    worktrees.map((worktree) => ({
      label: `${style.worktree(worktree.name)}  ${style.branch(worktree.branch ?? "detached")}`,
      value: worktree.path,
      description: `${worktree.role}, ${style.state(worktree.state, worktree.state)}`,
    })),
    options,
  );
  return worktrees.find((worktree) => worktree.path === selectedPath) ?? null;
}

export async function selectValue(
  question: string,
  choices: Choice[],
  options: PromptOptions = {},
): Promise<string> {
  const selected = await promptWithNavigation((signal) =>
    select(
      {
        message: question,
        choices: toInquirerChoices(choices),
        default: options.initialValue,
        pageSize: 10,
      },
      { signal },
    ),
  );
  return selected;
}

export async function searchSelect(
  question: string,
  choices: Choice[],
  options: PromptOptions = {},
): Promise<string> {
  const selected = await promptWithNavigation((signal) =>
    search(
      {
        message: question,
        pageSize: 10,
        default: options.initialValue,
        source: (term) => {
          const normalized = term?.trim().toLocaleLowerCase() ?? "";
          const matches = choices.filter((option) =>
            `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(normalized),
          );
          return matches.map(toInquirerChoice);
        },
      },
      { signal },
    ),
  );
  return selected;
}

export async function selectManyValues(
  question: string,
  choices: Choice[],
  options: PromptOptions = {},
): Promise<string[]> {
  return await promptWithNavigation((signal) =>
    checkbox(
      {
        message: question,
        choices: choices.map((option) => ({
          ...toInquirerChoice(option),
          checked: options.initialValues?.includes(option.value) ?? option.checked,
        })),
        pageSize: 10,
      },
      { signal },
    ),
  );
}

export async function selectManyWorktrees(
  question: string,
  worktrees: Worktree[],
  options: PromptOptions = {},
): Promise<Worktree[]> {
  const selectedPaths = await selectManyValues(
    question,
    worktrees.map((worktree) => ({
      label: `${style.worktree(worktree.name)}  ${style.branch(worktree.branch ?? "detached")}`,
      value: worktree.path,
      description: style.state(worktree.state, worktree.state),
    })),
    options,
  );
  return worktrees.filter((worktree) => selectedPaths.includes(worktree.path));
}

export async function promptText(
  question: string,
  defaultValue?: string,
  _options: PromptOptions = {},
): Promise<string> {
  return (
    await promptWithNavigation((signal) =>
      input(
        {
          message: question,
          default: defaultValue,
        },
        { signal },
      ),
    )
  ).trim();
}

export async function printWorktreeTable(worktrees: Worktree[]): Promise<void> {
  if ((process.stdout.columns ?? Number.POSITIVE_INFINITY) < 100) {
    for (const [index, worktree] of worktrees.entries()) {
      if (index > 0) process.stdout.write("\n");
      process.stdout.write(`${style.worktree(worktree.name)}\n`);
      process.stdout.write(`  Branch  ${style.branch(worktree.branch ?? "detached")}\n`);
      process.stdout.write(`  Role    ${worktree.role}\n`);
      process.stdout.write(`  Status  ${style.state(worktree.state, worktree.state)}\n`);
      process.stdout.write(`  Path    ${style.path(worktree.path)}\n`);
    }
    return;
  }
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
      if (column === 0) return style.worktree(cell);
      if (column === 1) return style.branch(cell);
      if (column === 3) return style.state(cell, worktrees[row]?.state);
      if (column === 4) return style.path(cell);
      return cell;
    },
  );
}

export async function printKeyValueTable(rows: Array<[string, string]>): Promise<void> {
  printTable(["SETTING", "VALUE"], rows, (cell, column) =>
    column === 0 ? style.label(cell) : style.value(cell),
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

function toInquirerChoices(
  choices: Choice[],
): Array<ReturnType<typeof toInquirerChoice> | Separator> {
  const rendered: Array<ReturnType<typeof toInquirerChoice> | Separator> = [];
  let previousGroup: string | undefined;
  for (const choice of choices) {
    if (choice.group && choice.group !== previousGroup) {
      rendered.push(new Separator(choice.group));
    }
    rendered.push(toInquirerChoice(choice));
    previousGroup = choice.group;
  }
  return rendered;
}

async function promptWithNavigation<T>(prompt: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onKeypress = (_input: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
    if (key?.name === "escape" && !key.ctrl) controller.abort();
  };
  process.stdin.on("keypress", onKeypress);
  try {
    return await prompt(controller.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortPromptError") throw new PromptBackError();
    if (error instanceof Error && error.name === "ExitPromptError") {
      throw new PromptExitError({ cause: error });
    }
    throw error;
  } finally {
    process.stdin.off("keypress", onKeypress);
  }
}
