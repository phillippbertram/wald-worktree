import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { YggError } from "../src/domain/errors.js";
import type { AutomationStep, Workspace } from "../src/domain/types.js";
import type { ProcessOptions } from "../src/infrastructure/process-runner.js";
import type { AutomationObserver } from "../src/services/automation-observer.js";
import { type AutomationContext, AutomationService } from "../src/services/automation-service.js";

describe("automation observer lifecycle", () => {
  it("routes command output through the observer and finishes successful runs", async () => {
    const commandOutput = new PassThrough();
    const observer = createObserver(commandOutput);
    const runArgv = vi.fn(async (_argv: string[], options: ProcessOptions) => {
      options.output?.write("child output\n");
    });
    const service = createService(runArgv, observer.value);

    await service.runSteps([commandStep()], automationContext());

    expect(observer.commandOutput).toHaveBeenCalledWith(1);
    expect(runArgv.mock.calls[0]?.[1].output).toBe(commandOutput);
    expect(observer.finish).toHaveBeenCalledOnce();
    expect(observer.finish).toHaveBeenCalledWith("success");
  });

  it("finishes interrupted runs before preserving exit code 130", async () => {
    const observer = createObserver();
    const runArgv = vi.fn(async () => {
      throw new YggError("Command interrupted.", { exitCode: 130 });
    });
    const service = createService(runArgv, observer.value);

    await expect(service.runSteps([commandStep()], automationContext())).rejects.toMatchObject({
      exitCode: 130,
    });

    expect(observer.row).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "FAILED", note: "Command interrupted." }),
    );
    expect(observer.finish).toHaveBeenCalledOnce();
    expect(observer.finish).toHaveBeenCalledWith("interrupted");
  });

  it("preserves the automation error when reporter cleanup fails", async () => {
    const observer = createObserver();
    observer.finish.mockImplementation(() => {
      throw new Error("renderer cleanup failed");
    });
    const runArgv = vi.fn(async () => {
      throw new YggError("Command interrupted.", { exitCode: 130 });
    });
    const service = createService(runArgv, observer.value);

    await expect(service.runSteps([commandStep()], automationContext())).rejects.toMatchObject({
      message: "Command interrupted.",
      exitCode: 130,
    });
  });

  it("continues configured failures and finishes the overall run successfully", async () => {
    const observer = createObserver();
    const runArgv = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("first failed"));
    const service = createService(runArgv, observer.value);

    await service.runSteps(
      [commandStep({ continueOnError: true }), commandStep()],
      automationContext(),
    );

    expect(observer.row).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED", note: "first failed; continuing" }),
    );
    expect(observer.row).toHaveBeenCalledWith(expect.objectContaining({ step: 2, status: "DONE" }));
    expect(observer.finish).toHaveBeenCalledWith("success");
  });
});

function createService(
  runArgv: (argv: string[], options: ProcessOptions) => Promise<void>,
  observer: AutomationObserver,
): AutomationService {
  return new AutomationService({ runArgv } as never, () => observer);
}

function createObserver(commandOutput?: NodeJS.WritableStream) {
  const start = vi.fn();
  const row = vi.fn();
  const separateStep = vi.fn();
  const output = vi.fn(() => commandOutput);
  const finish = vi.fn();
  return {
    start,
    row,
    separateStep,
    commandOutput: output,
    finish,
    value: {
      start,
      row,
      separateStep,
      commandOutput: output,
      finish,
    } satisfies AutomationObserver,
  };
}

function commandStep(overrides: Partial<AutomationStep> = {}): AutomationStep {
  return {
    type: "command",
    argv: ["node", "--version"],
    env: {},
    continueOnError: false,
    ...overrides,
  } as AutomationStep;
}

function automationContext(): AutomationContext {
  const root = process.cwd();
  const workspace: Workspace = {
    root,
    configPath: `${root}/workspace.yml`,
    sharedDir: `${root}/shared`,
    gitDir: `${root}/.git`,
    worktreeDir: root,
    primaryWorktree: root,
    config: {
      version: 1,
      mode: "adopted",
      paths: { git: ".git", worktrees: ".", primaryWorktree: "." },
      remote: null,
      defaultBranch: "main",
      trustedProjectConfig: null,
    },
  };
  return {
    workspace,
    event: "task:verify",
    branch: "feature/api",
    targetPath: root,
    current: null,
    defaultWorktree: null,
    primary: null,
    output: new PassThrough(),
  };
}
