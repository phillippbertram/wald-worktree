import type {
  AutomationObserver,
  AutomationPresentationContext,
  AutomationRow,
  AutomationStatus,
} from "../services/automation-observer.js";
import { style } from "./style.js";

const columnWidths = [4, 9, 8, 38, 34] as const;
const startedOutputs = new WeakSet<NodeJS.WritableStream>();

export class AutomationReporter implements AutomationObserver {
  private readonly narrow: boolean;

  constructor(
    private readonly output: NodeJS.WritableStream | undefined,
    private readonly context: AutomationPresentationContext,
  ) {
    this.narrow = readOutputColumns(output) < 100;
  }

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
    if (this.narrow) return;
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
    if (this.narrow) {
      this.write(
        `${style.value(row.step)}  ${styleAutomationStatus(row.status, row.status)}  ${style.label(row.type)}`,
      );
      this.write(`  ${style.label("Source")}  ${style.command(row.source)}`);
      this.write(`  ${style.label("Target")}  ${style.path(row.target)}`);
      if (row.note)
        this.write(`  ${style.label("Note")}    ${styleAutomationNote(row.note, row.status)}`);
      return;
    }
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

function readOutputColumns(output: NodeJS.WritableStream | undefined): number {
  if (!output || !("columns" in output)) return Number.POSITIVE_INFINITY;
  const columns = output.columns;
  return typeof columns === "number" ? columns : Number.POSITIVE_INFINITY;
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
