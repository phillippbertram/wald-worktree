import fs from "node:fs/promises";
import path from "node:path";
import { toErrorMessage, WaldError } from "../domain/errors.js";
import type {
  AutomationStep,
  HookEvent,
  ProjectConfigDocument,
  StepSource,
  Workspace,
  Worktree,
} from "../domain/types.js";
import { isPathInsideOrEqual } from "../infrastructure/path-utils.js";
import { ProcessRunner } from "../infrastructure/process-runner.js";
import { formatCommandForDisplay, formatShellForDisplay } from "../infrastructure/safe-text.js";
import {
  type AutomationObserver,
  type AutomationObserverFactory,
  type AutomationStatus,
  silentAutomationObserverFactory,
} from "./automation-observer.js";

export type AutomationContext = {
  workspace: Workspace;
  event: HookEvent | `task:${string}`;
  branch: string | null;
  targetPath: string;
  current: Worktree | null;
  defaultWorktree: Worktree | null;
  primary: Worktree | null;
  output?: NodeJS.WritableStream;
};

export class AutomationService {
  constructor(
    private readonly processes = new ProcessRunner(),
    private readonly createObserver: AutomationObserverFactory = silentAutomationObserverFactory,
  ) {}

  async runHook(
    document: ProjectConfigDocument | null,
    event: HookEvent,
    context: AutomationContext,
  ): Promise<void> {
    const steps = document?.config.hooks[event] ?? [];
    await this.runSteps(steps, { ...context, event });
  }

  async runTask(
    document: ProjectConfigDocument,
    name: string,
    context: AutomationContext,
  ): Promise<void> {
    const task = document.config.tasks[name];
    if (!task) {
      throw new WaldError(`Unknown project task: ${name}`);
    }
    await this.runSteps(task.steps, { ...context, event: `task:${name}` });
  }

  async runSteps(steps: AutomationStep[], context: AutomationContext): Promise<void> {
    if (steps.length === 0) return;
    const taskName = context.event.startsWith("task:") ? context.event.slice("task:".length) : null;
    const reporter = this.createObserver(context.output, {
      kind: taskName === null ? "Hook" : "Task",
      name: taskName ?? context.event,
      worktree: path.basename(context.targetPath),
      branch: context.branch,
      path: context.targetPath,
    });
    reporter.start();
    try {
      for (const [index, step] of steps.entries()) {
        const stepNumber = index + 1;
        if (index > 0) reporter.separateStep();
        const planned = describeStep(step, context);
        reporter.row({
          step: stepNumber,
          status: "RUNNING",
          type: step.type,
          source: planned.source,
          target: planned.target,
        });
        try {
          await this.runStep(step, context, stepNumber, reporter);
        } catch (error) {
          const interrupted = error instanceof WaldError && error.exitCode === 130;
          const presentation = describeStep(step, context, error);
          reporter.row({
            step: stepNumber,
            status: "FAILED",
            type: step.type,
            source: presentation.source,
            target: presentation.target,
            note: `${singleLine(toErrorMessage(error))}${step.continueOnError && !interrupted ? "; continuing" : ""}`,
          });
          if (interrupted) throw error;
          if (step.continueOnError) {
            continue;
          }
          throw new WaldError(
            `Automation step ${stepNumber} (${step.type} ${presentation.target}) failed: ${toErrorMessage(error)}`,
            { cause: error },
          );
        }
      }
    } catch (error) {
      try {
        reporter.finish(
          error instanceof WaldError && error.exitCode === 130 ? "interrupted" : "failed",
        );
      } catch {
        // A presentation cleanup failure must not replace the automation error or its exit code.
      }
      throw error;
    }
    reporter.finish("success");
  }

  private async runStep(
    step: AutomationStep,
    context: AutomationContext,
    stepNumber: number,
    reporter: AutomationObserver,
  ): Promise<void> {
    if (step.type === "command") {
      await this.runCommand(step, context, stepNumber, reporter);
      return;
    }
    await this.runFileStep(step, context, stepNumber, reporter);
  }

  private async runCommand(
    step: Extract<AutomationStep, { type: "command" }>,
    context: AutomationContext,
    stepNumber: number,
    reporter: AutomationObserver,
  ): Promise<void> {
    const cwd = resolveWorkingDirectory(step.cwd, context);
    await assertDirectory(cwd, "Command working directory");
    const command = formatConfiguredCommand(step);
    const environment = {
      ...step.env,
      WALD_EVENT: context.event,
      WALD_WORKSPACE_ROOT: context.workspace.root,
      WALD_SOURCE_PATH: resolvePreferredSource(context)?.path ?? "",
      WALD_WORKTREE_PATH: context.targetPath,
      WALD_BRANCH: context.branch ?? "",
    };
    const options = {
      cwd,
      env: environment,
      timeoutMs: step.timeoutSeconds ? step.timeoutSeconds * 1_000 : undefined,
      output: reporter.commandOutput(stepNumber) ?? context.output,
    };
    if (step.argv) {
      await this.processes.runArgv(step.argv, options);
    } else if (step.shell) {
      await this.processes.runShell(step.shell, options);
    } else {
      throw new WaldError("Command step has neither argv nor shell.");
    }
    reporter.row({
      step: stepNumber,
      status: "DONE",
      type: "command",
      source: command,
      target: cwd,
    });
  }

  private async runFileStep(
    step: Extract<AutomationStep, { type: "copy" | "symlink" }>,
    context: AutomationContext,
    stepNumber: number,
    reporter: AutomationObserver,
  ): Promise<void> {
    if (context.event !== "post_create" && !context.event.startsWith("task:")) {
      throw new WaldError(`${step.type} steps are only supported in post_create hooks and tasks.`);
    }
    const sourceRoot = resolveSourceRoot(step.source, context);
    if (!sourceRoot) {
      if (step.optional) {
        writeFileStepResult(
          reporter,
          stepNumber,
          step,
          configuredSourcePath(step),
          step.to,
          "SKIPPED",
          "source unavailable",
        );
        return;
      }
      throw new WaldError(`Cannot resolve ${step.source} source for ${step.type} step.`);
    }
    if (!context.targetPath) {
      throw new WaldError(`${step.type} steps require an existing target worktree.`);
    }

    const source = resolveRelativePath(sourceRoot, step.from, "Source path");
    const sourceStat = await lstatOrNull(source);
    if (!sourceStat) {
      if (step.optional) {
        writeFileStepResult(
          reporter,
          stepNumber,
          step,
          step.from,
          step.to,
          "SKIPPED",
          "source not found",
        );
        return;
      }
      throw new WaldError(`Source path does not exist: ${source}`);
    }
    if (step.source === "shared") {
      await assertSharedDirectory(context.workspace);
    }
    await assertRealPathInside(sourceRoot, source, "Source path");

    if (step.glob) {
      await runGlobFileStep(
        { ...step, glob: step.glob },
        sourceRoot,
        source,
        sourceStat,
        context.targetPath,
        stepNumber,
        reporter,
      );
      return;
    }

    const target = resolveRelativePath(context.targetPath, step.to, "Target path");
    await assertDestinationInside(context.targetPath, target);

    const relativeSource = path.relative(sourceRoot, source);
    const relativeTarget = path.relative(context.targetPath, target);
    const realSource = step.type === "symlink" ? await fs.realpath(source) : null;
    const targetStat = await lstatOrNull(target);
    if (targetStat && realSource && (await symlinkPointsTo(target, targetStat, realSource))) {
      writeFileStepResult(
        reporter,
        stepNumber,
        step,
        relativeSource,
        relativeTarget,
        "UNCHANGED",
        "already linked",
      );
      return;
    }
    if (targetStat && step.onExisting === "error") {
      throw targetConflictError(step, relativeSource, relativeTarget);
    }
    if (targetStat && step.onExisting === "skip") {
      writeFileStepResult(
        reporter,
        stepNumber,
        step,
        relativeSource,
        relativeTarget,
        "SKIPPED",
        "target exists",
      );
      return;
    }
    if (targetStat) {
      await fs.rm(target, { force: true, recursive: true });
    }
    await fs.mkdir(path.dirname(target), { recursive: true });

    if (step.type === "copy") {
      await copyWithoutSymlinks(source, target);
      writeFileStepResult(
        reporter,
        stepNumber,
        step,
        relativeSource,
        relativeTarget,
        targetStat ? "REPLACED" : "CREATED",
        targetStat ? "existing target" : undefined,
      );
      return;
    }

    if (!realSource) throw new Error("Symlink source was not resolved.");
    await fs.symlink(path.relative(path.dirname(target), realSource), target);
    writeFileStepResult(
      reporter,
      stepNumber,
      step,
      relativeSource,
      relativeTarget,
      targetStat ? "REPLACED" : "CREATED",
      targetStat ? "existing target" : undefined,
    );
  }
}

type FileStep = Extract<AutomationStep, { type: "copy" | "symlink" }>;

type PlannedFileOperation = {
  source: string;
  realSource: string;
  target: string;
  outcome: "create" | "unchanged" | "skip" | "replace";
};

type StepPresentation = {
  source: string;
  target: string;
};

class PresentedAutomationError extends WaldError {
  constructor(
    message: string,
    readonly presentation: StepPresentation,
  ) {
    super(message);
  }
}

async function runGlobFileStep(
  step: FileStep & { glob: string },
  sourceRoot: string,
  sourceDirectory: string,
  sourceStat: Awaited<ReturnType<typeof fs.lstat>>,
  targetRoot: string,
  stepNumber: number,
  reporter: AutomationObserver,
): Promise<void> {
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new WaldError(`Glob source must be a directory: ${sourceDirectory}`);
  }

  const targetDirectory = resolveRelativePath(targetRoot, step.to, "Target path");
  if (path.resolve(targetDirectory) !== path.resolve(targetRoot)) {
    await assertDestinationInside(targetRoot, targetDirectory);
  }
  const targetDirectoryStat = await statOrNull(targetDirectory);
  if (targetDirectoryStat && !targetDirectoryStat.isDirectory()) {
    throw new WaldError(`Glob target must be a directory: ${targetDirectory}`);
  }

  const matches: string[] = [];
  for await (const match of fs.glob(step.glob, { cwd: sourceDirectory })) {
    matches.push(match);
  }
  matches.sort((left, right) => left.localeCompare(right));

  const operations: PlannedFileOperation[] = [];
  const targets = new Set<string>();
  for (const match of matches) {
    const candidate = resolveRelativePath(sourceDirectory, match, "Glob match");
    const candidateStat = await lstatOrNull(candidate);
    if (!candidateStat || candidateStat.isDirectory()) {
      continue;
    }

    await assertRealPathInside(sourceRoot, candidate, "Glob match");
    const resolvedStat = candidateStat.isSymbolicLink() ? await fs.stat(candidate) : candidateStat;
    if (!resolvedStat.isFile()) {
      continue;
    }
    if (step.type === "copy" && candidateStat.isSymbolicLink()) {
      throw new WaldError(`Copy source contains a symbolic link: ${candidate}`);
    }

    const relativeMatch = path.relative(sourceDirectory, candidate);
    const target = resolveRelativePath(
      targetRoot,
      path.join(step.to, relativeMatch),
      "Target path",
    );
    if (targets.has(target)) {
      throw new WaldError(`Glob produces the same target more than once: ${target}`);
    }
    targets.add(target);
    operations.push({
      source: candidate,
      realSource: await fs.realpath(candidate),
      target,
      outcome: "create",
    });
  }

  if (operations.length === 0) {
    if (step.optional) {
      writeFileStepResult(
        reporter,
        stepNumber,
        step,
        configuredSourcePath(step),
        step.to,
        "SKIPPED",
        "no files matched",
      );
      return;
    }
    throw new WaldError(`Glob did not match any files: ${step.glob}`);
  }

  for (const operation of operations) {
    await assertDestinationInside(targetRoot, operation.target);
    const targetStat = await lstatOrNull(operation.target);
    if (!targetStat) continue;
    if (
      step.type === "symlink" &&
      (await symlinkPointsTo(operation.target, targetStat, operation.realSource))
    ) {
      operation.outcome = "unchanged";
      continue;
    }
    if (step.onExisting === "error") {
      throw targetConflictError(
        step,
        path.relative(sourceRoot, operation.source),
        path.relative(targetRoot, operation.target),
      );
    }
    operation.outcome = step.onExisting;
  }

  for (const operation of operations) {
    const relativeSource = path.relative(sourceRoot, operation.source);
    const relativeTarget = path.relative(targetRoot, operation.target);
    if (operation.outcome === "unchanged") {
      writeFileStepResult(
        reporter,
        stepNumber,
        step,
        relativeSource,
        relativeTarget,
        "UNCHANGED",
        "already linked",
      );
      continue;
    }
    if (operation.outcome === "skip") {
      writeFileStepResult(
        reporter,
        stepNumber,
        step,
        relativeSource,
        relativeTarget,
        "SKIPPED",
        "target exists",
      );
      continue;
    }
    if (operation.outcome === "replace") {
      await fs.rm(operation.target, { force: true, recursive: true });
    }
    await fs.mkdir(path.dirname(operation.target), { recursive: true });
    if (step.type === "copy") {
      await copyWithoutSymlinks(operation.source, operation.target);
    } else {
      await fs.symlink(
        path.relative(path.dirname(operation.target), operation.realSource),
        operation.target,
      );
    }
    writeFileStepResult(
      reporter,
      stepNumber,
      step,
      relativeSource,
      relativeTarget,
      operation.outcome === "replace" ? "REPLACED" : "CREATED",
      operation.outcome === "replace" ? "existing target" : undefined,
    );
  }
}

function writeFileStepResult(
  reporter: AutomationObserver,
  stepNumber: number,
  step: FileStep,
  source: string,
  target: string,
  status: Extract<AutomationStatus, "CREATED" | "UNCHANGED" | "SKIPPED" | "REPLACED">,
  note?: string,
): void {
  reporter.row({
    step: stepNumber,
    status,
    type: step.type,
    source: scopedPath(step.source, source),
    target: scopedPath("target", target),
    note,
  });
}

function configuredSourcePath(step: FileStep & { glob?: string }): string {
  const from = stripTrailingSlash(step.from);
  return step.glob ? [from, step.glob].filter(Boolean).join("/") : step.from;
}

function stripTrailingSlash(value: string): string {
  return value === "." ? "" : value.replace(/\/$/u, "");
}

function scopedPath(scope: StepSource | "target", relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/") || ".";
  return `${scope}:${normalized}`;
}

function describeStep(
  step: AutomationStep,
  context: AutomationContext,
  error?: unknown,
): StepPresentation {
  if (error instanceof PresentedAutomationError) return error.presentation;
  if (step.type === "command") {
    return {
      source: formatConfiguredCommand(step),
      target: resolveWorkingDirectory(step.cwd, context),
    };
  }
  return {
    source: scopedPath(step.source, configuredSourcePath(step)),
    target: scopedPath("target", step.to),
  };
}

function targetConflictError(
  step: FileStep,
  relativeSource: string,
  relativeTarget: string,
): PresentedAutomationError {
  const source = scopedPath(step.source, relativeSource);
  const target = scopedPath("target", relativeTarget);
  return new PresentedAutomationError(
    `Target ${target} already exists; configure on_existing: skip or replace.`,
    { source, target },
  );
}

async function symlinkPointsTo(
  target: string,
  targetStat: Awaited<ReturnType<typeof fs.lstat>>,
  realSource: string,
): Promise<boolean> {
  if (!targetStat.isSymbolicLink()) return false;
  try {
    return (await fs.realpath(target)) === realSource;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function formatConfiguredCommand(step: Extract<AutomationStep, { type: "command" }>): string {
  if (step.argv) return formatCommandForDisplay(step.argv);
  if (step.shell) return `/bin/sh -c ${JSON.stringify(formatShellForDisplay(step.shell))}`;
  return "command";
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function resolveWorkingDirectory(
  requested: Extract<AutomationStep, { type: "command" }>["cwd"],
  context: AutomationContext,
): string {
  if (requested === "workspace") {
    return context.workspace.root;
  }
  if (requested === "source") {
    return resolvePreferredSource(context)?.path ?? context.workspace.root;
  }
  if (requested === "target") {
    return context.targetPath;
  }
  if (context.event === "pre_create") {
    return resolvePreferredSource(context)?.path ?? context.workspace.root;
  }
  if (context.event === "post_remove") {
    return context.workspace.root;
  }
  return context.targetPath;
}

function resolveSourceRoot(source: StepSource, context: AutomationContext): string | null {
  switch (source) {
    case "current":
      return context.current?.path ?? null;
    case "primary":
      return context.primary?.path ?? null;
    case "default":
      return context.defaultWorktree?.path ?? null;
    case "shared":
      return context.workspace.sharedDir;
  }
}

function resolvePreferredSource(context: AutomationContext): Worktree | null {
  return context.current ?? context.defaultWorktree ?? context.primary;
}

function resolveRelativePath(root: string, relativePath: string, label: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new WaldError(`${label} must be a relative path.`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!isPathInsideOrEqual(root, resolved)) {
    throw new WaldError(`${label} must stay inside its configured source.`);
  }
  return resolved;
}

async function assertRealPathInside(root: string, candidate: string, label: string): Promise<void> {
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  if (!isPathInsideOrEqual(realRoot, realCandidate)) {
    throw new WaldError(`${label} resolves outside its worktree.`);
  }
}

async function assertSharedDirectory(workspace: Workspace): Promise<void> {
  const stat = await fs.lstat(workspace.sharedDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WaldError(
      `Shared path must be a directory, not a link or file: ${workspace.sharedDir}`,
    );
  }
  const [realMetadata, realShared] = await Promise.all([
    fs.realpath(path.dirname(workspace.configPath)),
    fs.realpath(workspace.sharedDir),
  ]);
  if (!isPathInsideOrEqual(realMetadata, realShared)) {
    throw new WaldError("Shared path resolves outside the workspace metadata directory.");
  }
}

async function assertDestinationInside(root: string, candidate: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let parent = path.dirname(candidate);
  while (!(await lstatOrNull(parent))) {
    const next = path.dirname(parent);
    if (next === parent) {
      throw new WaldError(`Cannot resolve target parent: ${candidate}`);
    }
    parent = next;
  }
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) {
    throw new WaldError(`Target parent is not a directory: ${parent}`);
  }
  const realParent = await fs.realpath(parent);
  if (!isPathInsideOrEqual(realRoot, realParent)) {
    throw new WaldError("Target path resolves outside its worktree.");
  }
}

async function copyWithoutSymlinks(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    throw new WaldError(`Copy source contains a symbolic link: ${source}`);
  }
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true, mode: stat.mode });
    for (const entry of await fs.readdir(source)) {
      await copyWithoutSymlinks(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new WaldError(`Copy source is not a regular file or directory: ${source}`);
  }
  await fs.copyFile(source, target);
  await fs.chmod(target, stat.mode);
}

async function assertDirectory(directory: string, label: string): Promise<void> {
  const stat = await lstatOrNull(directory);
  if (!stat?.isDirectory()) {
    throw new WaldError(`${label} does not exist: ${directory}`);
  }
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function statOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
