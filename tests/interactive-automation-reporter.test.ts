import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clack = vi.hoisted(() => {
  const commandLog = {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  };
  return {
    commandLog,
    intro: vi.fn(),
    log: {
      message: vi.fn(),
      step: vi.fn(),
    },
    outro: vi.fn(),
    taskLog: vi.fn(() => commandLog),
  };
});

vi.mock("@clack/prompts", () => clack);

import { InteractiveAutomationReporter } from "../src/ui/interactive-automation-reporter.js";

describe("interactive automation reporting", () => {
  beforeEach(() => {
    clack.commandLog.error.mockReset();
    clack.commandLog.message.mockReset();
    clack.commandLog.success.mockReset();
    clack.intro.mockReset();
    clack.log.message.mockReset();
    clack.log.step.mockReset();
    clack.outro.mockReset();
    clack.taskLog.mockClear();
  });

  it("uses a ten-line retained task log and releases the command stream on success", () => {
    const output = new PassThrough();
    const reporter = new InteractiveAutomationReporter(output, {
      kind: "Task",
      name: "verify",
      worktree: "feature",
      branch: "feature/api",
      path: "/workspace/feature",
    });
    reporter.start();
    reporter.row({
      step: 1,
      status: "RUNNING",
      type: "command",
      source: "pnpm test",
      target: "/workspace/feature",
    });

    expect(clack.taskLog).toHaveBeenCalledWith({
      title: expect.stringContaining("1 command  pnpm test"),
      limit: 10,
      retainLog: true,
      spacing: 0,
      output,
    });

    const commandOutput = reporter.commandOutput(1);
    commandOutput?.write(Buffer.from([0xe2, 0x82]));
    commandOutput?.write(Buffer.from([0xac]));
    commandOutput?.write("\nfinished");
    reporter.row({
      step: 1,
      status: "DONE",
      type: "command",
      source: "pnpm test",
      target: "/workspace/feature",
    });

    expect(clack.commandLog.message).toHaveBeenCalledWith("€", { raw: true });
    expect(clack.commandLog.message).toHaveBeenCalledWith("\nfinished", { raw: true });
    expect(clack.commandLog.success).toHaveBeenCalledWith(expect.stringContaining("DONE"), {
      showLog: true,
    });
    expect(commandOutput).toMatchObject({ writableEnded: true });
    expect(reporter.commandOutput(1)).toBeUndefined();
  });

  it("retains failed output and marks successful runs with continued failures as warnings", () => {
    const output = new PassThrough();
    const reporter = new InteractiveAutomationReporter(output, {
      kind: "Hook",
      name: "post_create",
      worktree: "feature",
      branch: null,
      path: "/workspace/feature",
    });
    reporter.start();
    reporter.row({
      step: 1,
      status: "RUNNING",
      type: "command",
      source: "pnpm test",
      target: "/workspace/feature",
    });
    reporter.commandOutput(1)?.write("failure details\n");
    reporter.row({
      step: 1,
      status: "FAILED",
      type: "command",
      source: "pnpm test",
      target: "/workspace/feature",
      note: "exit code 1; continuing",
    });
    reporter.finish("success");

    expect(clack.commandLog.message).toHaveBeenCalledWith("failure details", { raw: true });
    expect(clack.commandLog.error).toHaveBeenCalledWith(expect.stringContaining("FAILED"));
    expect(clack.outro).toHaveBeenCalledWith(expect.stringContaining("continued"), { output });
  });
});
