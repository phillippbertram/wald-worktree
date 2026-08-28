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

export type AutomationRunOutcome = "success" | "failed" | "interrupted";

export interface AutomationObserver {
  start(): void;
  row(row: AutomationRow): void;
  separateStep(): void;
  commandOutput(step: number): NodeJS.WritableStream | undefined;
  finish(outcome: AutomationRunOutcome): void;
}

export type AutomationObserverFactory = (
  output: NodeJS.WritableStream | undefined,
  context: AutomationPresentationContext,
) => AutomationObserver;

export const silentAutomationObserverFactory: AutomationObserverFactory = () => ({
  start: () => undefined,
  row: () => undefined,
  separateStep: () => undefined,
  commandOutput: () => undefined,
  finish: () => undefined,
});
