import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { intro, log, outro, spinner, taskLog } from "@clack/prompts";
import pc from "picocolors";
import type {
  AutomationObserver,
  AutomationPresentationContext,
  AutomationRow,
  AutomationRunOutcome,
  AutomationStatus,
} from "../services/automation-observer.js";
import { style } from "./style.js";

type CommandTaskLog = ReturnType<typeof taskLog>;
type StepSpinner = ReturnType<typeof spinner>;
type TaskLogTarget = Pick<CommandTaskLog, "message">;

type ActiveStep = {
  row: AutomationRow;
  title: string;
  startedAt: number;
  results: AutomationRow[];
  spinner: StepSpinner;
  commandBuffer?: CommandOutputBuffer;
  commandContext?: string;
  commandStream?: TaskLogWritable;
};

const summaryStatuses: AutomationStatus[] = [
  "CREATED",
  "REPLACED",
  "UNCHANGED",
  "SKIPPED",
  "DONE",
  "FAILED",
];

export class InteractiveAutomationReporter implements AutomationObserver {
  private readonly counts = new Map<AutomationStatus, number>();
  private readonly steps = new Set<number>();
  private activeStep: ActiveStep | undefined;
  private separateBeforeNextStep = false;

  constructor(
    private readonly output: Writable,
    private readonly context: AutomationPresentationContext,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    intro(`${style.label(this.context.kind)} ${style.value(this.context.name)}`, {
      output: this.output,
    });
    log.message(
      [
        `${style.label("Worktree")}  ${style.worktree(this.context.worktree)}`,
        `${style.label("Branch")}    ${this.context.branch ? style.branch(this.context.branch) : style.value("detached")}`,
        `${style.label("Path")}      ${style.path(this.context.path)}`,
      ],
      { output: this.output, spacing: 0 },
    );
  }

  row(row: AutomationRow): void {
    if (row.status === "RUNNING") {
      this.beginStep(row);
      return;
    }

    this.increment(row.status);
    if (!this.activeStep || this.activeStep.row.step !== row.step) {
      this.beginStep({ ...row, status: "RUNNING" });
    }
    if (row.type === "command") {
      this.finishCommand(row);
      return;
    }
    this.activeStep?.results.push(row);
  }

  separateStep(): void {
    this.flushActiveStep();
    this.separateBeforeNextStep = true;
  }

  commandOutput(step: number): NodeJS.WritableStream | undefined {
    return this.activeStep?.row.step === step ? this.activeStep.commandStream : undefined;
  }

  finish(outcome: AutomationRunOutcome): void {
    this.flushActiveStep();
    const failed = this.counts.get("FAILED") ?? 0;
    const qualifier =
      outcome === "interrupted"
        ? " · interrupted"
        : outcome === "success" && failed > 0
          ? " · continued"
          : "";
    const summary = `${formatCount(this.steps.size, "step")}${formatStatusSummary(this.counts)}${qualifier}`;
    const styled =
      outcome === "failed"
        ? style.danger(summary)
        : outcome === "interrupted" || failed > 0
          ? style.warning(summary)
          : style.success(summary);
    outro(styled, { output: this.output });
  }

  private beginStep(row: AutomationRow): void {
    this.flushActiveStep();
    if ((this.steps.size === 0 || this.separateBeforeNextStep) && row.type !== "command") {
      log.message("", { output: this.output, spacing: 0 });
    }
    this.separateBeforeNextStep = false;
    this.steps.add(row.step);
    const title = formatStepTitle(row);
    const stepSpinner = spinner({
      output: this.output,
      withGuide: false,
    });
    const active: ActiveStep = {
      row,
      title,
      startedAt: this.now(),
      results: [],
      spinner: stepSpinner,
    };
    if (row.type === "command") {
      if (row.target !== this.context.path) {
        active.commandContext = `${style.label("CWD")}  ${style.path(row.target)}`;
      }
      active.commandBuffer = new CommandOutputBuffer((lines) => {
        stepSpinner.message(formatActiveStep(title, active.commandContext, lines));
      });
      active.commandStream = new TaskLogWritable(active.commandBuffer);
    }
    stepSpinner.start(formatActiveStep(title, active.commandContext));
    this.activeStep = active;
  }

  private finishCommand(row: AutomationRow): void {
    const active = this.activeStep;
    if (!active?.commandBuffer) return;
    active.commandStream?.close();
    active.spinner.clear();
    const commandLog = taskLog({
      title: active.title,
      limit: 10,
      retainLog: true,
      spacing: 0,
      output: this.output,
    });
    if (active.commandContext) commandLog.message(active.commandContext);
    active.commandBuffer.replay(commandLog);
    const duration = formatDuration(this.now() - active.startedAt);
    const message = `${styleAutomationStatus(row.status, row.status)} · ${duration}${row.note ? ` · ${styleAutomationNote(row.note, row.status)}` : ""}`;
    if (row.status === "FAILED") commandLog.error(message);
    else commandLog.success(message, { showLog: true });
    this.activeStep = undefined;
  }

  private flushActiveStep(): void {
    const active = this.activeStep;
    if (!active) return;
    active.commandStream?.close();
    active.spinner.clear();
    if (active.row.type !== "command") {
      log.step(active.title, { output: this.output, spacing: 0 });
      this.writeFileResults(active);
    }
    this.activeStep = undefined;
  }

  private writeFileResults(active: ActiveStep): void {
    const aggregate = active.results.length > 1;
    for (const [index, result] of active.results.entries()) {
      const samePaths =
        active.results.length === 1 &&
        result.source === active.row.source &&
        result.target === active.row.target;
      const detail = samePaths
        ? ""
        : `  ${style.path(result.source)} ${pc.dim("→")} ${style.path(result.target)}`;
      const note = result.note ? ` · ${styleAutomationNote(result.note, result.status)}` : "";
      const last = index === active.results.length - 1 && !aggregate;
      log.message(`${styleAutomationStatus(result.status, result.status)}${detail}${note}`, {
        output: this.output,
        spacing: 0,
        symbol: pc.gray(last ? "└" : "├"),
        secondarySymbol: pc.gray("│"),
      });
    }
    if (aggregate) {
      const counts = countStatuses(active.results);
      log.message(formatStatusSummary(counts).replace(/^ · /u, ""), {
        output: this.output,
        spacing: 0,
        symbol: pc.gray("└"),
        secondarySymbol: pc.gray("│"),
      });
    }
  }

  private increment(status: AutomationStatus): void {
    this.counts.set(status, (this.counts.get(status) ?? 0) + 1);
  }
}

class CommandOutputBuffer implements TaskLogTarget {
  private value = "";

  constructor(private readonly onChange: (lines: string[]) => void) {}

  message(message: string): void {
    this.value += message;
    this.onChange(this.previewLines());
  }

  replay(target: TaskLogTarget): void {
    if (this.value) target.message(this.value, { raw: true });
  }

  private previewLines(): string[] {
    return stripVTControlCharacters(this.value)
      .replace(/\r\n/gu, "\n")
      .replace(/\r/gu, "\n")
      .split("\n")
      .slice(-10);
  }
}

class TaskLogWritable extends Writable {
  private readonly decoder = new StringDecoder("utf8");
  private flushed = false;
  private pendingNewlines = "";

  constructor(private readonly target: TaskLogTarget) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const message = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      this.writeMessage(message);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    const remaining = this.decoder.end();
    this.writeMessage(remaining);
    const preservedNewlines = this.pendingNewlines.replace(/\r?\n$/u, "");
    if (preservedNewlines) this.target.message(preservedNewlines, { raw: true });
    this.pendingNewlines = "";
  }

  close(): void {
    if (this.writableEnded) return;
    this.flush();
    this.end();
  }

  private writeMessage(message: string): void {
    if (!message) return;
    const combined = `${this.pendingNewlines}${message}`;
    const trailingNewlines = combined.match(/(?:\r?\n)+$/u)?.[0] ?? "";
    const content = combined.slice(0, combined.length - trailingNewlines.length);
    this.pendingNewlines = trailingNewlines;
    if (content) this.target.message(content, { raw: true });
  }
}

function formatActiveStep(title: string, context?: string, output: string[] = []): string {
  const details = [context, ...output.map((line) => pc.dim(line))].filter(
    (line): line is string => line !== undefined,
  );
  return [title, ...details.map((line) => `${pc.gray("│")}  ${line}`)].join("\n");
}

function formatStepTitle(row: AutomationRow): string {
  const source = row.type === "command" ? style.command(row.source) : style.path(row.source);
  if (row.type === "command") {
    return `${style.value(row.step)} ${style.label(row.type)}  ${source}`;
  }
  return `${style.value(row.step)} ${style.label(row.type)}  ${source} ${pc.dim("→")} ${style.path(row.target)}`;
}

function countStatuses(rows: AutomationRow[]): Map<AutomationStatus, number> {
  const counts = new Map<AutomationStatus, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return counts;
}

function formatStatusSummary(counts: Map<AutomationStatus, number>): string {
  const parts = summaryStatuses.flatMap((status) => {
    const count = counts.get(status) ?? 0;
    return count > 0 ? [`${count} ${status.toLocaleLowerCase()}`] : [];
  });
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
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
