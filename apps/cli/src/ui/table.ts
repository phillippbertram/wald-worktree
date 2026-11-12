import { stripVTControlCharacters } from "node:util";
import Table from "cli-table3";
import pc from "picocolors";

const borderlessChars = {
  top: "",
  "top-mid": "",
  "top-left": "",
  "top-right": "",
  bottom: "",
  "bottom-mid": "",
  "bottom-left": "",
  "bottom-right": "",
  left: "",
  "left-mid": "",
  mid: "",
  "mid-mid": "",
  right: "",
  "right-mid": "",
  middle: "  ",
} as const;

export function renderTable(
  headers: string[],
  rows: string[][],
  formatCell: (cell: string, column: number, row: number) => string = (cell) => cell,
  width = process.stdout.isTTY ? process.stdout.columns : undefined,
): string {
  const naturalWidths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => stripVTControlCharacters(row[index] ?? "").length),
    ),
  );
  const needsWrapping =
    width !== undefined &&
    naturalWidths.reduce((sum, value) => sum + value, 0) + (headers.length - 1) * 2 > width;
  const firstWidth = Math.min(naturalWidths[0] ?? 0, Math.floor((width ?? 80) / 3));
  const table = new Table({
    chars: borderlessChars,
    head: headers.map((header) => pc.cyan(pc.bold(header))),
    ...(needsWrapping && headers.length === 2
      ? {
          colWidths: [Math.max(1, firstWidth), Math.max(1, (width ?? 80) - firstWidth - 2)],
          wordWrap: true,
          wrapOnWordBoundary: false,
        }
      : {}),
    style: {
      border: [],
      head: [],
      "padding-left": 0,
      "padding-right": 0,
    },
  });
  table.push(
    ...rows.map((row, rowIndex) =>
      row.map((cell, columnIndex) => formatCell(cell, columnIndex, rowIndex)),
    ),
  );
  return table
    .toString()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}
