import fs from "node:fs/promises";
import path from "node:path";
import { toErrorMessage, WtError } from "../domain/errors.js";
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
  constructor(private readonly processes = new ProcessRunner()) {}

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
      throw new WtError(`Unknown project task: ${name}`);
    }
    await this.runSteps(task.steps, { ...context, event: `task:${name}` });
  }

  async runSteps(steps: AutomationStep[], context: AutomationContext): Promise<void> {
    for (const [index, step] of steps.entries()) {
      try {
        await this.runStep(step, context);
      } catch (error) {
        if (step.continueOnError) {
          writeLine(
            context.output ?? process.stderr,
            `Warning: step ${index + 1} failed and was allowed to continue: ${toErrorMessage(error)}`,
          );
          continue;
        }
        throw new WtError(`Automation step ${index + 1} failed: ${toErrorMessage(error)}`, {
          cause: error,
        });
      }
    }
  }

  private async runStep(step: AutomationStep, context: AutomationContext): Promise<void> {
    if (step.type === "command") {
      await this.runCommand(step, context);
      return;
    }
    await this.runFileStep(step, context);
  }

  private async runCommand(
    step: Extract<AutomationStep, { type: "command" }>,
    context: AutomationContext,
  ): Promise<void> {
    const cwd = resolveWorkingDirectory(step.cwd, context);
    await assertDirectory(cwd, "Command working directory");
    const environment = {
      ...step.env,
      WT_EVENT: context.event,
      WT_WORKSPACE_ROOT: context.workspace.root,
      WT_SOURCE_PATH: resolvePreferredSource(context)?.path ?? "",
      WT_WORKTREE_PATH: context.targetPath,
      WT_BRANCH: context.branch ?? "",
    };
    const options = {
      cwd,
      env: environment,
      timeoutMs: step.timeoutSeconds ? step.timeoutSeconds * 1_000 : undefined,
      output: context.output,
    };
    if (step.argv) {
      await this.processes.runArgv(step.argv, options);
    } else if (step.shell) {
      await this.processes.runShell(step.shell, options);
    } else {
      throw new WtError("Command step has neither argv nor shell.");
    }
  }

  private async runFileStep(
    step: Extract<AutomationStep, { type: "copy" | "symlink" }>,
    context: AutomationContext,
  ): Promise<void> {
    if (context.event !== "post_create" && !context.event.startsWith("task:")) {
      throw new WtError(`${step.type} steps are only supported in post_create hooks and tasks.`);
    }
    const sourceWorktree = resolveSource(step.source, context);
    if (!sourceWorktree) {
      if (step.optional) {
        return;
      }
      throw new WtError(`Cannot resolve ${step.source} source worktree for ${step.type} step.`);
    }
    if (!context.targetPath) {
      throw new WtError(`${step.type} steps require an existing target worktree.`);
    }

    const source = resolveRelativePath(sourceWorktree.path, step.from, "Source path");
    const target = resolveRelativePath(context.targetPath, step.to, "Target path");
    const sourceStat = await lstatOrNull(source);
    if (!sourceStat) {
      if (step.optional) {
        return;
      }
      throw new WtError(`Source path does not exist: ${source}`);
    }
    await assertRealPathInside(sourceWorktree.path, source, "Source path");
    await assertDestinationInside(context.targetPath, target);

    const targetStat = await lstatOrNull(target);
    if (targetStat && !step.overwrite) {
      throw new WtError(`Target path already exists: ${target}`);
    }
    if (targetStat) {
      await fs.rm(target, { force: true, recursive: true });
    }
    await fs.mkdir(path.dirname(target), { recursive: true });

    if (step.type === "copy") {
      await copyWithoutSymlinks(source, target);
      return;
    }

    const realSource = await fs.realpath(source);
    await fs.symlink(path.relative(path.dirname(target), realSource), target);
  }
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

function resolveSource(source: StepSource, context: AutomationContext): Worktree | null {
  switch (source) {
    case "current":
      return context.current;
    case "primary":
      return context.primary;
    case "default":
      return context.defaultWorktree;
  }
}

function resolvePreferredSource(context: AutomationContext): Worktree | null {
  return context.current ?? context.defaultWorktree ?? context.primary;
}

function resolveRelativePath(root: string, relativePath: string, label: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new WtError(`${label} must be a relative path.`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!isPathInsideOrEqual(root, resolved)) {
    throw new WtError(`${label} must stay inside its worktree.`);
  }
  return resolved;
}

async function assertRealPathInside(root: string, candidate: string, label: string): Promise<void> {
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  if (!isPathInsideOrEqual(realRoot, realCandidate)) {
    throw new WtError(`${label} resolves outside its worktree.`);
  }
}

async function assertDestinationInside(root: string, candidate: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let parent = path.dirname(candidate);
  while (!(await lstatOrNull(parent))) {
    const next = path.dirname(parent);
    if (next === parent) {
      throw new WtError(`Cannot resolve target parent: ${candidate}`);
    }
    parent = next;
  }
  const realParent = await fs.realpath(parent);
  if (!isPathInsideOrEqual(realRoot, realParent)) {
    throw new WtError("Target path resolves outside its worktree.");
  }
}

async function copyWithoutSymlinks(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    throw new WtError(`Copy source contains a symbolic link: ${source}`);
  }
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true, mode: stat.mode });
    for (const entry of await fs.readdir(source)) {
      await copyWithoutSymlinks(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new WtError(`Copy source is not a regular file or directory: ${source}`);
  }
  await fs.copyFile(source, target);
  await fs.chmod(target, stat.mode);
}

async function assertDirectory(directory: string, label: string): Promise<void> {
  const stat = await lstatOrNull(directory);
  if (!stat?.isDirectory()) {
    throw new WtError(`${label} does not exist: ${directory}`);
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

function writeLine(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}
