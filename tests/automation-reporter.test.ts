import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { AutomationReporter, createAutomationReporter } from "../src/ui/automation-reporter.js";
import { InteractiveAutomationReporter } from "../src/ui/interactive-automation-reporter.js";

describe("automation terminal reporting", () => {
  it("uses readable multiline records in narrow terminals", () => {
    let output = "";
    const stream = {
      columns: 80,
      write: (value: string) => {
        output += value;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const reporter = new AutomationReporter(stream, {
      kind: "Task",
      name: "verify",
      worktree: "feature",
      branch: "feature/api",
      path: "/workspace/feature",
    });

    reporter.start();
    reporter.row({
      step: 1,
      status: "FAILED",
      type: "command",
      source: "pnpm test",
      target: "/workspace/feature",
      note: "exit code 1",
    });

    expect(output).not.toContain("SOURCE / COMMAND");
    expect(output).toContain("1  FAILED  command");
    expect(output).toContain("Source  pnpm test");
    expect(output).toContain("Note    exit code 1");
  });

  it("selects the interactive reporter only for a TTY output stream", () => {
    const plain = new PassThrough();
    const interactive = new PassThrough();
    Object.defineProperty(interactive, "isTTY", { value: true });
    const context = presentationContext();

    expect(createAutomationReporter(plain, context)).toBeInstanceOf(AutomationReporter);
    expect(createAutomationReporter(interactive, context)).toBeInstanceOf(
      InteractiveAutomationReporter,
    );
  });

  it("keeps the structured layout instead of switching to columns in a narrow TTY", () => {
    const stream = new PassThrough();
    Object.defineProperties(stream, {
      isTTY: { value: true },
      columns: { value: 40 },
    });
    const reporter = createAutomationReporter(stream, presentationContext("Hook", "post_create"));

    reporter.start();
    reporter.row({
      step: 1,
      status: "RUNNING",
      type: "symlink",
      source: "shared:env/**/*.env*",
      target: "target:.",
    });
    reporter.row({
      step: 1,
      status: "UNCHANGED",
      type: "symlink",
      source: "shared:env/apps/api/.env.local",
      target: "target:apps/api/.env.local",
      note: "already linked",
    });
    reporter.finish("success");

    const output = stripVTControlCharacters(stream.read()?.toString() ?? "");
    expect(output).toContain("Hook post_create");
    expect(output).toContain("1 symlink  shared:env/**/*.env* → target:.");
    expect(output).toContain("shared:env/apps/api/.env.local");
    expect(output).not.toContain("SOURCE / COMMAND");
  });

  it("groups file results and retains normalized command output in the interactive layout", () => {
    const stream = new PassThrough();
    const times = [0, 1_250, 2_500];
    const reporter = new InteractiveAutomationReporter(
      stream,
      presentationContext("Hook", "post_create"),
      () => times.shift() ?? 1_250,
    );

    reporter.start();
    reporter.row({
      step: 1,
      status: "RUNNING",
      type: "symlink",
      source: "shared:env/**/*.env*",
      target: "target:.",
    });
    reporter.row({
      step: 1,
      status: "UNCHANGED",
      type: "symlink",
      source: "shared:env/apps/api/.env.local",
      target: "target:apps/api/.env.local",
      note: "already linked",
    });
    reporter.row({
      step: 1,
      status: "UNCHANGED",
      type: "symlink",
      source: "shared:env/apps/web/.env.local",
      target: "target:apps/web/.env.local",
      note: "already linked",
    });
    reporter.separateStep();
    reporter.row({
      step: 2,
      status: "RUNNING",
      type: "command",
      source: "pnpm install --frozen-lockfile",
      target: "/workspace/feature/apps/api",
    });
    reporter
      .commandOutput(2)
      ?.write(
        `${Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n")}\ncursor\u001B[2Jnormalized\n`,
      );
    reporter.row({
      step: 2,
      status: "DONE",
      type: "command",
      source: "pnpm install --frozen-lockfile",
      target: "/workspace/feature/apps/api",
    });
    reporter.finish("success");

    const output = stream.read()?.toString() ?? "";
    const plain = stripVTControlCharacters(output);
    expect(plain).toContain("Hook post_create");
    expect(plain).toContain("Worktree  feature");
    expect(plain.match(/1 symlink/gu)).toHaveLength(1);
    expect(plain).not.toContain("RUNNING");
    expect(plain).toContain("shared:env/apps/api/.env.local → target:apps/api/.env.local");
    expect(plain).toContain("2 unchanged");
    expect(plain).toContain("2 command  pnpm install --frozen-lockfile");
    expect(plain).toContain("CWD  /workspace/feature/apps/api");
    expect(plain).toContain("line-1");
    expect(plain).toContain("line-12");
    expect(plain).toContain("cursornormalized");
    expect(output).not.toContain("\u001B[2J");
    expect(plain).toContain("DONE · 1.3s");
    expect(plain).toContain("2 steps · 2 unchanged · 1 done");
  });
});

function presentationContext(kind: "Hook" | "Task" = "Task", name = "verify") {
  return {
    kind,
    name,
    worktree: "feature",
    branch: "feature/api",
    path: "/workspace/feature",
  } as const;
}
