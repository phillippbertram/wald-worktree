import fs from "node:fs/promises";
import path from "node:path";
import { toErrorMessage, YggError } from "../domain/errors.js";
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
      throw new YggError(`Unknown project task: ${name}`);
    }
    await this.runSteps(task.steps, { ...context, event: `task:${name}` });
  }

  async runSteps(steps: AutomationStep[], context: AutomationContext): Promise<void> {
    for (const [index, step] of steps.entries()) {
      try {
        await this.runStep(step, context);
      } catch (error) {
        if (error instanceof YggError && error.exitCode === 130) {
          throw error;
        }
        if (step.continueOnError) {
          writeLine(
            context.output ?? process.stderr,
            `Warning: step ${index + 1} failed and was allowed to continue: ${toErrorMessage(error)}`,
          );
          continue;
        }
        throw new YggError(`Automation step ${index + 1} failed: ${toErrorMessage(error)}`, {
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
      YGG_EVENT: context.event,
      YGG_WORKSPACE_ROOT: context.workspace.root,
      YGG_SOURCE_PATH: resolvePreferredSource(context)?.path ?? "",
      YGG_WORKTREE_PATH: context.targetPath,
      YGG_BRANCH: context.branch ?? "",
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
      throw new YggError("Command step has neither argv nor shell.");
    }
  }

  private async runFileStep(
    step: Extract<AutomationStep, { type: "copy" | "symlink" }>,
    context: AutomationContext,
  ): Promise<void> {
    if (context.event !== "post_create" && !context.event.startsWith("task:")) {
      throw new YggError(`${step.type} steps are only supported in post_create hooks and tasks.`);
    }
    const sourceRoot = resolveSourceRoot(step.source, context);
    if (!sourceRoot) {
      if (step.optional) {
        return;
      }
      throw new YggError(`Cannot resolve ${step.source} source for ${step.type} step.`);
    }
    if (!context.targetPath) {
      throw new YggError(`${step.type} steps require an existing target worktree.`);
    }

    const source = resolveRelativePath(sourceRoot, step.from, "Source path");
    const sourceStat = await lstatOrNull(source);
    if (!sourceStat) {
      if (step.optional) {
        return;
      }
      throw new YggError(`Source path does not exist: ${source}`);
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
      );
      return;
    }

    const target = resolveRelativePath(context.targetPath, step.to, "Target path");
    await assertDestinationInside(context.targetPath, target);

    const targetStat = await lstatOrNull(target);
    if (targetStat && !step.overwrite) {
      throw new YggError(`Target path already exists: ${target}`);
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

type FileStep = Extract<AutomationStep, { type: "copy" | "symlink" }>;

type PlannedFileOperation = {
  source: string;
  realSource: string;
  target: string;
};

async function runGlobFileStep(
  step: FileStep & { glob: string },
  sourceRoot: string,
  sourceDirectory: string,
  sourceStat: Awaited<ReturnType<typeof fs.lstat>>,
  targetRoot: string,
): Promise<void> {
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new YggError(`Glob source must be a directory: ${sourceDirectory}`);
  }

  const targetDirectory = resolveRelativePath(targetRoot, step.to, "Target path");
  if (path.resolve(targetDirectory) !== path.resolve(targetRoot)) {
    await assertDestinationInside(targetRoot, targetDirectory);
  }
  const targetDirectoryStat = await statOrNull(targetDirectory);
  if (targetDirectoryStat && !targetDirectoryStat.isDirectory()) {
    throw new YggError(`Glob target must be a directory: ${targetDirectory}`);
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
      throw new YggError(`Copy source contains a symbolic link: ${candidate}`);
    }

    const relativeMatch = path.relative(sourceDirectory, candidate);
    const target = resolveRelativePath(
      targetRoot,
      path.join(step.to, relativeMatch),
      "Target path",
    );
    if (targets.has(target)) {
      throw new YggError(`Glob produces the same target more than once: ${target}`);
    }
    targets.add(target);
    operations.push({ source: candidate, realSource: await fs.realpath(candidate), target });
  }

  if (operations.length === 0) {
    if (step.optional) {
      return;
    }
    throw new YggError(`Glob did not match any files: ${step.glob}`);
  }

  for (const operation of operations) {
    await assertDestinationInside(targetRoot, operation.target);
    const targetStat = await lstatOrNull(operation.target);
    if (targetStat && !step.overwrite) {
      throw new YggError(`Target path already exists: ${operation.target}`);
    }
  }

  for (const operation of operations) {
    if (await lstatOrNull(operation.target)) {
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
    throw new YggError(`${label} must be a relative path.`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!isPathInsideOrEqual(root, resolved)) {
    throw new YggError(`${label} must stay inside its configured source.`);
  }
  return resolved;
}

async function assertRealPathInside(root: string, candidate: string, label: string): Promise<void> {
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  if (!isPathInsideOrEqual(realRoot, realCandidate)) {
    throw new YggError(`${label} resolves outside its worktree.`);
  }
}

async function assertSharedDirectory(workspace: Workspace): Promise<void> {
  const stat = await fs.lstat(workspace.sharedDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new YggError(
      `Shared path must be a directory, not a link or file: ${workspace.sharedDir}`,
    );
  }
  const [realMetadata, realShared] = await Promise.all([
    fs.realpath(path.dirname(workspace.configPath)),
    fs.realpath(workspace.sharedDir),
  ]);
  if (!isPathInsideOrEqual(realMetadata, realShared)) {
    throw new YggError("Shared path resolves outside the workspace metadata directory.");
  }
}

async function assertDestinationInside(root: string, candidate: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let parent = path.dirname(candidate);
  while (!(await lstatOrNull(parent))) {
    const next = path.dirname(parent);
    if (next === parent) {
      throw new YggError(`Cannot resolve target parent: ${candidate}`);
    }
    parent = next;
  }
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) {
    throw new YggError(`Target parent is not a directory: ${parent}`);
  }
  const realParent = await fs.realpath(parent);
  if (!isPathInsideOrEqual(realRoot, realParent)) {
    throw new YggError("Target path resolves outside its worktree.");
  }
}

async function copyWithoutSymlinks(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    throw new YggError(`Copy source contains a symbolic link: ${source}`);
  }
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true, mode: stat.mode });
    for (const entry of await fs.readdir(source)) {
      await copyWithoutSymlinks(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new YggError(`Copy source is not a regular file or directory: ${source}`);
  }
  await fs.copyFile(source, target);
  await fs.chmod(target, stat.mode);
}

async function assertDirectory(directory: string, label: string): Promise<void> {
  const stat = await lstatOrNull(directory);
  if (!stat?.isDirectory()) {
    throw new YggError(`${label} does not exist: ${directory}`);
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

function writeLine(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}
