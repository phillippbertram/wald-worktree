import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WaldError } from "../src/domain/errors.js";
import { ProcessRunner } from "../src/infrastructure/process-runner.js";

describe("process execution", () => {
  let temporaryRoot: string;
  const runner = new ProcessRunner();

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wald-process-test-"));
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  it("passes argv values literally without shell expansion", async () => {
    await runner.runArgv(
      [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
        "literal.txt",
        "$HOME && echo unsafe",
      ],
      { cwd: temporaryRoot },
    );

    expect(await fs.readFile(path.join(temporaryRoot, "literal.txt"), "utf8")).toBe(
      "$HOME && echo unsafe",
    );
  });

  it("reports configured command timeouts", async () => {
    await expect(
      runner.runArgv([process.execPath, "-e", "setTimeout(() => {}, 10_000)"], {
        cwd: temporaryRoot,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out after 20ms/u);
  });

  it("redacts credentials from failed command diagnostics", async () => {
    const failure = runner.runArgv(
      [process.execPath, "-e", "process.exit(7)", "--", "--token", "do-not-print-me"],
      { cwd: temporaryRoot },
    );

    await expect(failure).rejects.toMatchObject({
      message: expect.stringContaining("--token <redacted>"),
    });
    await expect(failure).rejects.not.toThrow(/do-not-print-me/u);
  });

  it("reports SIGINT as a conventional interruption", async () => {
    const interruption = runner.runArgv(
      [process.execPath, "-e", "process.kill(process.pid, 'SIGINT')"],
      { cwd: temporaryRoot },
    );

    await expect(interruption).rejects.toMatchObject({
      message: "Command interrupted.",
      exitCode: 130,
      name: WaldError.name,
    });
  });
});
