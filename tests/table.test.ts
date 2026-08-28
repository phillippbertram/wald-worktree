import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "../src/domain/types.js";
import { renderTable } from "../src/ui/table.js";
import { printWorktreeTable } from "../src/ui/terminal.js";

describe("terminal tables", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders ANSI-aware tables without borders and with two spaces between full columns", () => {
    const rendered = renderTable(
      ["NAME", "PATH"],
      [
        ["One", "/tmp/one"],
        ["Long", "/tmp/a-very-long-path"],
      ],
      (cell, column, row) => (column === 0 && row === 0 ? `\u001B[31m${cell}\u001B[39m` : cell),
    );
    const plain = stripVTControlCharacters(rendered);

    expect(rendered).toContain("\u001B[31mOne\u001B[39m");
    expect(plain.split("\n")).toEqual([
      "NAME  PATH",
      "One   /tmp/one",
      "Long  /tmp/a-very-long-path",
    ]);
    expect(plain).not.toMatch(/[│┌┐└┘├┤┬┴┼]/u);
  });

  it("uses the wide borderless worktree table at 100 columns and above", async () => {
    const restoreColumns = overrideStdoutColumns(120);
    const output = captureStdout();

    try {
      await printWorktreeTable([worktree()]);
    } finally {
      restoreColumns();
    }

    const plain = stripVTControlCharacters(output());
    expect(plain).toContain("NAME     BRANCH        ROLE    STATUS    PATH");
    expect(plain).toContain("feature  feature/work  linked  modified  /tmp/workspaces/feature");
    expect(plain).not.toMatch(/[│┌┐└┘├┤┬┴┼]/u);
  });

  it("keeps the card view below 100 columns, including long paths", async () => {
    const restoreColumns = overrideStdoutColumns(99);
    const output = captureStdout();

    try {
      await printWorktreeTable([worktree()]);
    } finally {
      restoreColumns();
    }

    const plain = stripVTControlCharacters(output());
    expect(plain).toBe(
      [
        "feature",
        "  Branch  feature/work",
        "  Role    linked",
        "  Status  modified",
        "  Path    /tmp/workspaces/feature",
        "",
      ].join("\n"),
    );
    expect(plain).not.toContain("NAME");
  });
});

function worktree(): Worktree {
  return {
    name: "feature",
    role: "linked",
    path: "/tmp/workspaces/feature",
    head: "0123456789abcdef",
    branch: "feature/work",
    branchRef: "refs/heads/feature/work",
    locked: false,
    lockReason: null,
    prunable: false,
    state: "modified",
  };
}

function captureStdout(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join("");
}

function overrideStdoutColumns(columns: number): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  return () => {
    if (descriptor) Object.defineProperty(process.stdout, "columns", descriptor);
    else Reflect.deleteProperty(process.stdout, "columns");
  };
}
