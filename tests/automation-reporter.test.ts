import { describe, expect, it } from "vitest";
import { AutomationReporter } from "../src/ui/automation-reporter.js";

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
});
