import { style } from "./style.js";

export type AutomationStatus =
  | "RUNNING"
  | "DONE"
  | "CREATED"
  | "UNCHANGED"
  | "SKIPPED"
  | "REPLACED"
  | "FAILED";

export type AutomationRow = {
  step: number;
  status: AutomationStatus;
  type: "command" | "copy" | "symlink";
  source: string;
  target: string;
  note?: string;
};

export type AutomationPresentationContext = {
  kind: "Hook" | "Task";
  name: string;
  worktree: string;
  branch: string | null;
  path: string;
};

const columnWidths = [4, 9, 8, 38, 34] as const;
const startedOutputs = new WeakSet<NodeJS.WritableStream>();

export class AutomationReporter {
  constructor(
    private readonly output: NodeJS.WritableStream | undefined,
    private readonly context: AutomationPresentationContext,
  ) {}

  start(): void {
    if (!this.output) return;
    if (startedOutputs.has(this.output)) this.write("");
    else startedOutputs.add(this.output);
    this.writeContext(this.context.kind, style.value(this.context.name));
    this.writeContext("Worktree", style.worktree(this.context.worktree));
    this.writeContext(
      "Branch",
      this.context.branch ? style.branch(this.context.branch) : style.value("detached"),
    );
    this.writeContext("Path", style.path(this.context.path));
    this.write("");
    this.write(
      formatColumns(
        ["STEP", "STATUS", "TYPE", "SOURCE / COMMAND", "TARGET / CWD", "NOTE"],
        (cell) => style.label(cell),
      ),
    );
  }

  row(row: AutomationRow): void {
    if (!this.output) return;
    const cells = [String(row.step), row.status, row.type, row.source, row.target, row.note ?? ""];
    this.write(
      formatColumns(cells, (cell, column) => {
        switch (column) {
          case 0:
            return style.value(cell);
          case 1:
            return styleAutomationStatus(cell, row.status);
          case 2:
            return style.label(cell);
          case 3:
            return row.type === "command" ? style.command(cell) : style.path(cell);
          case 4:
            return style.path(cell);
          case 5:
            return styleAutomationNote(cell, row.status);
          default:
            return cell;
        }
      }),
    );
  }

  separateStep(): void {
    if (this.output) this.write("");
  }

  private writeContext(label: string, value: string): void {
    this.write(`${style.label(label.padEnd(10))}  ${value}`);
  }

  private write(value: string): void {
    this.output?.write(`${value}\n`);
  }
}

function formatColumns(
  cells: string[],
  format: (paddedCell: string, column: number) => string,
): string {
  return cells
    .map((cell, column) => {
      const width = columnWidths[column];
      const padded = width === undefined ? cell : cell.padEnd(Math.max(width, cell.length));
      const separator = column === cells.length - 1 ? "" : "  ";
      return `${format(padded, column)}${separator}`;
    })
    .join("");
}

function styleAutomationStatus(value: string, status: AutomationStatus): string {
  switch (status) {
    case "DONE":
    case "CREATED":
      return style.success(value);
    case "UNCHANGED":
    case "RUNNING":
      return style.label(value);
    case "SKIPPED":
    case "REPLACED":
      return style.warning(value);
    case "FAILED":
      return style.danger(value);
  }
}

function styleAutomationNote(value: string, status: AutomationStatus): string {
  if (status === "FAILED") return style.danger(value);
  if (status === "SKIPPED" || status === "REPLACED") return style.warning(value);
  return value;
}
