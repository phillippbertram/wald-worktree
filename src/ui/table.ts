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
): string {
  const table = new Table({
    chars: borderlessChars,
    head: headers.map((header) => pc.cyan(pc.bold(header))),
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
