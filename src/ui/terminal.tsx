import { ConfirmInput, MultiSelect, Select, Spinner, StatusMessage } from "@inkjs/ui";
import { Box, render, Text, useApp } from "ink";
import { useEffect, useRef } from "react";
import type {
  EnvironmentFileStatus,
  EnvironmentImportCandidate,
  Worktree,
} from "../domain/types.js";

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

export async function selectEnvironmentFiles(
  candidates: EnvironmentImportCandidate[],
): Promise<string[]> {
  let selected: string[] = [];
  const importable = candidates.filter(
    (candidate) => candidate.state === "new" || candidate.state === "same",
  );

  function EnvironmentSelect(): React.JSX.Element {
    const { exit } = useApp();
    return (
      <Box flexDirection="column">
        <Text>Select environment files (space toggles, enter confirms):</Text>
        <MultiSelect
          defaultValue={importable.map((candidate) => candidate.path)}
          options={importable.map((candidate) => ({
            label: `${candidate.path}  ${candidate.state}`,
            value: candidate.path,
          }))}
          visibleOptionCount={Math.min(10, Math.max(1, importable.length))}
          onSubmit={(values) => {
            selected = values;
            exit();
          }}
        />
      </Box>
    );
  }

  await render(<EnvironmentSelect />).waitUntilExit();
  return selected;
}

export async function printWorktreeTable(worktrees: Worktree[]): Promise<void> {
  const rows = worktrees.map((worktree) => [
    worktree.name,
    worktree.branch ?? "detached",
    worktree.state,
    worktree.path,
  ]);
  await renderOnce(<Table headers={["NAME", "BRANCH", "STATUS", "PATH"]} rows={rows} />);
}

export async function printEnvironmentTable(
  rows: Array<{ worktree: Worktree; status: EnvironmentFileStatus }>,
): Promise<void> {
  await renderOnce(
    <Table
      headers={["WORKTREE", "FILE", "STATUS"]}
      rows={rows.map(({ worktree, status }) => [worktree.name, status.path, status.state])}
    />,
  );
}

export async function printCandidateTable(candidates: EnvironmentImportCandidate[]): Promise<void> {
  await renderOnce(
    <Table
      headers={["FILE", "ACTION"]}
      rows={candidates.map((candidate) => [candidate.path, candidate.state])}
    />,
  );
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
