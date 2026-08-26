import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { execa } from "execa";
import { WtError } from "../domain/errors.js";

export type ProcessOptions = {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  output?: NodeJS.WritableStream;
};

export class ProcessRunner {
  async runArgv(argv: string[], options: ProcessOptions): Promise<void> {
    const [command, ...args] = argv;
    if (!command) {
      throw new WtError("Cannot execute an empty command.");
    }
    await this.run(command, args, options);
  }

  async runShell(command: string, options: ProcessOptions): Promise<void> {
    await this.run("/bin/sh", ["-c", command], options);
  }

  async runInteractive(argv: string[], cwd: string): Promise<void> {
    const [command, ...args] = argv;
    if (!command) {
      throw new WtError("Cannot execute an empty command.");
    }
    const result = await execa(command, args, {
      cwd,
      reject: false,
      stdio: "inherit",
    }).catch((error: unknown) => {
      throw new WtError(`Could not start command: ${command}`, { cause: error });
    });
    if (result.signal === "SIGINT" || result.exitCode === 130) {
      throw new WtError("Command interrupted.", { exitCode: 130 });
    }
    if (result.exitCode !== 0) {
      throw new WtError(`Command failed with exit code ${result.exitCode}: ${argv.join(" ")}`, {
        exitCode: result.exitCode ?? 1,
      });
    }
  }

  async runInteractiveShell(command: string, cwd: string): Promise<void> {
    await this.runInteractive(["/bin/sh", "-c", command], cwd);
  }

  async launchDetached(argv: string[], cwd: string): Promise<void> {
    const [command, ...args] = argv;
    if (!command) {
      throw new WtError("Cannot launch an empty tool command.");
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: "ignore",
      });
      child.once("error", (error) =>
        reject(new WtError(`Could not launch tool: ${command}`, { cause: error })),
      );
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  private async run(command: string, args: string[], options: ProcessOptions): Promise<void> {
    const output = (options.output ?? process.stderr) as Writable;
    const result = await execa(command, args, {
      cwd: options.cwd,
      env: options.env,
      reject: false,
      stdin: process.stdin.isTTY ? "inherit" : "ignore",
      stdout: output,
      stderr: output,
      timeout: options.timeoutMs,
    }).catch((error: unknown) => {
      throw new WtError(`Could not start command: ${command}`, { cause: error });
    });
    if (result.timedOut) {
      throw new WtError(
        `Command timed out after ${options.timeoutMs ?? 0}ms: ${[command, ...args].join(" ")}`,
      );
    }
    if (result.signal === "SIGINT" || result.exitCode === 130) {
      throw new WtError("Command interrupted.", { exitCode: 130 });
    }
    if (result.exitCode !== 0) {
      const outcome =
        result.exitCode === undefined
          ? `signal ${result.signal ?? "unknown"}`
          : `exit code ${result.exitCode}`;
      throw new WtError(`Command failed with ${outcome}: ${[command, ...args].join(" ")}`, {
        exitCode: result.exitCode ?? 1,
      });
    }
  }
}
