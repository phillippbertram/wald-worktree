import { stripVTControlCharacters } from "node:util";
import {
  autocomplete,
  confirm as clackConfirm,
  spinner as createSpinner,
  isCancel,
  log,
  multiselect,
  select,
  text,
} from "@clack/prompts";
import { YggError } from "../domain/errors.js";
import type { Worktree } from "../domain/types.js";
import { style } from "./style.js";
import { renderTable } from "./table.js";

type Choice = {
  label: string;
  value: string;
  description?: string;
  checked?: boolean;
  group?: string;
};

type ClackChoice = {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
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

  const spinner = createSpinner({ output: process.stderr, withGuide: false });
  spinner.start(label);
  try {
    const result = await task();
    spinner.clear();
    return result;
  } catch (error) {
    spinner.clear();
    throw error;
  }
}

export async function confirm(
  question: string,
  defaultValue = false,
  _options: PromptOptions = {},
): Promise<boolean> {
  return await promptWithNavigation((signal) =>
    clackConfirm({ message: question, initialValue: defaultValue, signal }),
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
  return await promptWithNavigation((signal) =>
    select({
      message: question,
      options: toClackChoices(choices, true),
      initialValue: options.initialValue,
      maxItems: 10,
      signal,
    }),
  );
}

export async function searchSelect(
  question: string,
  choices: Choice[],
  options: PromptOptions = {},
): Promise<string> {
  const choicesByValue = new Map(choices.map((choice) => [choice.value, choice]));
  return await promptWithNavigation((signal) =>
    autocomplete({
      message: question,
      options: toClackChoices(choices, false),
      initialValue: options.initialValue,
      maxItems: 10,
      signal,
      filter: (term, option) => {
        const choice = choicesByValue.get(option.value);
        const searchable = choice
          ? `${choice.label} ${choice.description ?? ""} ${choice.value}`
          : `${option.label ?? ""} ${option.hint ?? ""} ${option.value}`;
        return stripVTControlCharacters(searchable)
          .toLocaleLowerCase()
          .includes(term.trim().toLocaleLowerCase());
      },
    }),
  );
}

export async function selectManyValues(
  question: string,
  choices: Choice[],
  options: PromptOptions = {},
): Promise<string[]> {
  return await promptWithNavigation((signal) =>
    multiselect({
      message: question,
      options: toClackChoices(choices, false),
      initialValues:
        options.initialValues ??
        choices.filter((choice) => choice.checked).map((choice) => choice.value),
      maxItems: 10,
      required: false,
      signal,
    }),
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
      text({ message: question, initialValue: defaultValue, signal }),
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
  process.stdout.write(
    `${renderTable(
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
    )}\n`,
  );
}

export async function printKeyValueTable(rows: Array<[string, string]>): Promise<void> {
  process.stdout.write(
    `${renderTable(["SETTING", "VALUE"], rows, (cell, column) =>
      column === 0 ? style.label(cell) : style.value(cell),
    )}\n`,
  );
}

export async function printStatus(
  variant: "success" | "error" | "warning" | "info",
  message: string,
): Promise<void> {
  const logger = variant === "warning" ? log.warn : log[variant];
  logger(message, { output: process.stdout, spacing: 0 });
}

function toClackChoices(choices: Choice[], includeGroups: boolean): ClackChoice[] {
  const rendered: ClackChoice[] = [];
  let previousGroup: string | undefined;
  for (const [index, choice] of choices.entries()) {
    if (includeGroups && choice.group && choice.group !== previousGroup) {
      rendered.push({
        value: `__ygg_group_${index}`,
        label: `── ${choice.group.toLocaleUpperCase()} ──`,
        disabled: true,
      });
    }
    rendered.push({
      value: choice.value,
      label: choice.label,
      hint: choice.description,
    });
    previousGroup = choice.group;
  }
  return rendered;
}

async function promptWithNavigation<T>(
  prompt: (signal: AbortSignal) => Promise<T | symbol>,
): Promise<T> {
  const controller = new AbortController();
  let cancellation: "back" | "exit" | undefined;
  const onKeypress = (input: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
    if (key?.name === "escape" && !key.ctrl) cancellation = "back";
    if ((key?.name === "c" && key.ctrl) || input === "\u0003") cancellation = "exit";
  };
  process.stdin.on("keypress", onKeypress);
  try {
    const result = await prompt(controller.signal);
    if (!isCancel(result)) return result;
    if (cancellation === "back") throw new PromptBackError();
    throw new PromptExitError();
  } finally {
    process.stdin.off("keypress", onKeypress);
  }
}
