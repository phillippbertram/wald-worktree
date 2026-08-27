import pc from "picocolors";
import type { WorktreeState } from "../domain/types.js";

export const style = {
  branch: (value: string): string => pc.magenta(value),
  command: (value: string): string => pc.green(pc.bold(value)),
  danger: (value: string): string => pc.red(pc.bold(value)),
  hash: (value: string): string => pc.dim(value),
  heading: (value: string): string => pc.bold(value),
  label: (value: string): string => pc.cyan(pc.bold(value)),
  path: (value: string): string => pc.blue(value),
  state: (value: string, state: WorktreeState | undefined): string => {
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
  },
  success: (value: string): string => pc.green(pc.bold(value)),
  value: (value: string | number): string => pc.bold(String(value)),
  warning: (value: string): string => pc.yellow(pc.bold(value)),
  worktree: (value: string): string => pc.cyan(pc.bold(value)),
};
