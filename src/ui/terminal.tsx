import { ConfirmInput, MultiSelect, Select, Spinner, StatusMessage, TextInput } from "@inkjs/ui";
import { Box, render, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Worktree } from "../domain/types.js";

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function runTask<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!isInteractiveTerminal()) {
    return await task();
  }

  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;

  function Task(): React.JSX.Element {
    const { exit } = useApp();
    const started = useRef(false);
    useEffect(() => {
      if (started.current) {
        return;
      }
      started.current = true;
      task()
        .then((value) => {
          outcome = { ok: true, value };
        })
        .catch((error: unknown) => {
          outcome = { ok: false, error };
        })
        .finally(exit);
    }, [exit]);
    return <Spinner label={label} />;
  }

  await render(<Task />).waitUntilExit();
  if (!outcome) {
    throw new Error(`${label} was cancelled.`);
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

export async function confirm(question: string): Promise<boolean> {
  let answer = false;

  function Confirmation(): React.JSX.Element {
    const { exit } = useApp();
    return (
      <Box flexDirection="column">
        <Text>{question}</Text>
        <ConfirmInput
          defaultChoice="cancel"
          onConfirm={() => {
            answer = true;
            exit();
          }}
          onCancel={() => {
            exit();
          }}
        />
      </Box>
    );
  }

  await render(<Confirmation />).waitUntilExit();
  return answer;
}

export async function selectWorktree(worktrees: Worktree[]): Promise<Worktree | null> {
  let selected: Worktree | null = null;

  function WorktreeSelect(): React.JSX.Element {
    const { exit } = useApp();
    return (
      <Box flexDirection="column">
        <Text>Select a worktree:</Text>
        <Select
          options={worktrees.map((worktree) => ({
            label: `${worktree.name}  ${worktree.branch ?? "detached"}`,
            value: worktree.path,
          }))}
          onChange={(value) => {
            selected = worktrees.find((worktree) => worktree.path === value) ?? null;
            exit();
          }}
        />
      </Box>
    );
  }

  await render(<WorktreeSelect />).waitUntilExit();
  return selected;
}

export async function selectValue(
  question: string,
  options: Array<{ label: string; value: string }>,
): Promise<string | null> {
  let selected: string | null = null;

  function ValueSelect(): React.JSX.Element {
    const { exit } = useApp();
    return (
      <Box flexDirection="column">
        <Text>{question}</Text>
        <Select
          options={options}
          onChange={(value) => {
            selected = value;
            exit();
          }}
        />
      </Box>
    );
  }

  await render(<ValueSelect />).waitUntilExit();
  return selected;
}

export async function searchSelect(
  question: string,
  options: Array<{ label: string; value: string; description?: string }>,
): Promise<string | null> {
  let selected: string | null = null;

  function SearchSelection(): React.JSX.Element {
    const { exit } = useApp();
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const filtered = useMemo(() => {
      const normalized = query.toLocaleLowerCase();
      return options.filter((option) =>
        `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(normalized),
      );
    }, [query]);

    useEffect(() => {
      setSelectedIndex((current) => Math.min(current, Math.max(0, filtered.length - 1)));
    }, [filtered.length]);

    useInput((input, key) => {
      if (key.escape) {
        exit();
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((current) => Math.min(filtered.length - 1, current + 1));
        return;
      }
      if (key.return) {
        selected = filtered[selectedIndex]?.value ?? null;
        exit();
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((current) => current.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input && isPrintableInput(input)) {
        setQuery((current) => `${current}${input}`);
      }
    });

    const firstVisible = Math.max(0, selectedIndex - 4);
    const visible = filtered.slice(firstVisible, firstVisible + 10);
    return (
      <Box flexDirection="column">
        <Text>{question}</Text>
        <Text dimColor>Filter: {query || "type to search"}</Text>
        {visible.length === 0 ? (
          <Text color="yellow">No matches</Text>
        ) : (
          visible.map((option, index) => {
            const actualIndex = firstVisible + index;
            const active = actualIndex === selectedIndex;
            return (
              <Text key={option.value} color={active ? "cyan" : undefined}>
                {active ? "❯ " : "  "}
                {option.label}
                {option.description ? `  ${option.description}` : ""}
              </Text>
            );
          })
        )}
      </Box>
    );
  }

  await render(<SearchSelection />).waitUntilExit();
  return selected;
}

function isPrintableInput(input: string): boolean {
  return [...input].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  });
}

export async function selectManyWorktrees(
  question: string,
  worktrees: Worktree[],
): Promise<Worktree[]> {
  let selectedPaths: string[] = [];

  function WorktreeMultiSelect(): React.JSX.Element {
    const { exit } = useApp();
    return (
      <Box flexDirection="column">
        <Text>{question}</Text>
        <MultiSelect
          options={worktrees.map((worktree) => ({
            label: `${worktree.name}  ${worktree.branch ?? "detached"}  ${worktree.state}`,
            value: worktree.path,
          }))}
          visibleOptionCount={Math.min(10, Math.max(1, worktrees.length))}
          onSubmit={(values) => {
            selectedPaths = values;
            exit();
          }}
        />
      </Box>
    );
  }

  await render(<WorktreeMultiSelect />).waitUntilExit();
  return worktrees.filter((worktree) => selectedPaths.includes(worktree.path));
}

export async function promptText(question: string, defaultValue?: string): Promise<string> {
  let answer = "";

  function Prompt(): React.JSX.Element {
    const { exit } = useApp();
    return (
      <Box flexDirection="column">
        <Text>{question}</Text>
        <TextInput
          defaultValue={defaultValue}
          onSubmit={(value) => {
            answer = value;
            exit();
          }}
        />
      </Box>
    );
  }

  await render(<Prompt />).waitUntilExit();
  return answer.trim();
}

export async function printWorktreeTable(worktrees: Worktree[]): Promise<void> {
  const rows = worktrees.map((worktree) => [
    worktree.name,
    worktree.branch ?? "detached",
    worktree.role,
    worktree.state,
    worktree.path,
  ]);
  await renderOnce(<Table headers={["NAME", "BRANCH", "ROLE", "STATUS", "PATH"]} rows={rows} />);
}

export async function printKeyValueTable(rows: Array<[string, string]>): Promise<void> {
  await renderOnce(<Table headers={["SETTING", "VALUE"]} rows={rows} />);
}

export async function printStatus(
  variant: "success" | "error" | "warning" | "info",
  message: string,
): Promise<void> {
  await renderOnce(<StatusMessage variant={variant}>{message}</StatusMessage>);
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }): React.JSX.Element {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );

  const renderRow = (row: string[], bold = false): React.JSX.Element => (
    <Box>
      {row.map((cell, index) => (
        <Text key={`${headers[index] ?? "column"}-${cell}`} bold={bold}>
          {cell.padEnd((widths[index] ?? cell.length) + (index === row.length - 1 ? 0 : 2))}
        </Text>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {renderRow(headers, true)}
      {rows.map((row) => (
        <Box key={row.join("\0")}>{renderRow(row)}</Box>
      ))}
    </Box>
  );
}

async function renderOnce(element: React.JSX.Element): Promise<void> {
  function StaticOutput(): React.JSX.Element {
    const { exit } = useApp();
    useEffect(() => {
      exit();
    }, [exit]);
    return element;
  }

  await render(<StaticOutput />).waitUntilExit();
}
