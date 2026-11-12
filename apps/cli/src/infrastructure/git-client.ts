import { execa } from "execa";
import { WaldError } from "../domain/errors.js";
import { redactSensitiveText, sanitizeTerminalText } from "./safe-text.js";

export type GitRunOptions = {
  cwd?: string;
  gitDir?: string;
  input?: string;
  reject?: boolean;
  stripFinalNewline?: boolean;
};

export type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class GitClient {
  async run(args: string[], options: GitRunOptions = {}): Promise<GitResult> {
    const commandArgs = options.gitDir ? [`--git-dir=${options.gitDir}`, ...args] : args;

    const result = await execa("git", commandArgs, {
      cwd: options.cwd,
      input: options.input,
      reject: false,
      stdin: options.input === undefined ? "ignore" : undefined,
      stripFinalNewline: options.stripFinalNewline ?? true,
    }).catch((error: unknown) => {
      throw new WaldError("Git could not be started. Is Git installed and available in PATH?", {
        cause: error,
      });
    });

    const output: GitResult = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
    };

    if (options.reject !== false && output.exitCode !== 0) {
      const rawDetail = output.stderr.trim() || output.stdout.trim() || "Git command failed.";
      const detail = sanitizeTerminalText(redactSensitiveText(rawDetail), { multiline: true });
      throw new WaldError(detail, { exitCode: output.exitCode });
    }

    return output;
  }

  async succeeds(args: string[], options: Omit<GitRunOptions, "reject"> = {}): Promise<boolean> {
    const result = await this.run(args, { ...options, reject: false });
    return result.exitCode === 0;
  }
}
