import pc from "picocolors";
import type { WorktreeState } from "../domain/types.js";
import { sanitizeTerminalText } from "../infrastructure/safe-text.js";

const safe = (value: string | number): string => sanitizeTerminalText(String(value));

export const style = {
  branch: (value: string): string => pc.magenta(safe(value)),
  command: (value: string): string => pc.green(pc.bold(safe(value))),
  danger: (value: string): string => pc.red(pc.bold(safe(value))),
  hash: (value: string): string => pc.dim(safe(value)),
  heading: (value: string): string => pc.bold(safe(value)),
  label: (value: string): string => pc.cyan(pc.bold(safe(value))),
  path: (value: string): string => pc.blue(safe(value)),
  state: (value: string, state: WorktreeState | undefined): string => {
    const rendered = safe(value);
    switch (state) {
      case "clean":
        return pc.green(rendered);
      case "modified":
        return pc.yellow(rendered);
      case "locked":
      case "missing":
        return pc.red(rendered);
      case "unavailable":
        return pc.red(rendered);
      default:
        return rendered;
    }
  },
  success: (value: string): string => pc.green(pc.bold(safe(value))),
  value: (value: string | number): string => pc.bold(safe(value)),
  warning: (value: string): string => pc.yellow(pc.bold(safe(value))),
  worktree: (value: string): string => pc.cyan(pc.bold(safe(value))),
};
