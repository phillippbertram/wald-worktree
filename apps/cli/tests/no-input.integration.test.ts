import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliArguments, cliExecutable } from "./helpers/cli.js";
import { createTestRepository } from "./helpers/git-repository.js";

function tty(cwd: string, ...args: string[]) {
  return execa(
    "python3",
    [
      path.join(import.meta.dirname, "helpers/without-terminal-input.py"),
      cliExecutable,
      ...cliArguments(...args),
    ],
    { cwd, reject: false },
  );
}

describe.skipIf(process.platform === "win32")(
  "unattended CLI in a real terminal",
  { timeout: 30000 },
  () => {
    let root: string;
    let workspace: string;
    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "wald-no-input-"));
      const repository = await createTestRepository(root);
      workspace = path.join(root, "workspace");
      await execa(cliExecutable, cliArguments("init", repository.remote, workspace), { cwd: root });
    });
    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it("prints help or identifies missing input regardless of global option position", async () => {
      const help = await tty(workspace, "--no-input");
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("Usage: wald");
      for (const args of [
        ["--no-input", "create"],
        ["remove", "--no-input", "--dry-run"],
      ]) {
        const result = await tty(workspace, ...args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/Specify.*(branch|worktree)/u);
      }
    });

    it("reports structured errors without input for apply operations missing --yes", async () => {
      await execa(cliExecutable, cliArguments("create", "stale"), { cwd: workspace });
      await fs.rm(path.join(workspace, "stale"), { recursive: true });
      const prune = await tty(workspace, "prune", "--apply", "--json");
      expect(prune.exitCode).toBe(1);
      expect(prune.stdout).toBe("");
      expect(JSON.parse(prune.stderr).message).toContain("--yes");
      await execa(cliExecutable, cliArguments("prune", "--apply", "--yes"), { cwd: workspace });
      const uninit = await tty(workspace, "uninit", "--apply", "--json");
      expect(uninit.exitCode).toBe(1);
      expect(uninit.stdout).toBe("");
      expect(JSON.parse(uninit.stderr).message).toContain("--yes");
      expect(await fs.stat(path.join(workspace, ".wald"))).toBeTruthy();
    });

    it("resolves an implicit exec target and preserves the full child argument vector and input", async () => {
      await execa(cliExecutable, cliArguments("create", "topic"), { cwd: workspace });
      const topic = await fs.realpath(path.join(workspace, "topic"));
      const args = [
        "--",
        "node",
        "-e",
        "console.log(JSON.stringify([process.cwd(), ...process.argv.slice(1)]));process.stdin.pipe(process.stdout)",
        "--",
        "--json",
        "-C",
        "two words",
        "",
        "--",
      ];
      for (const cwd of [workspace, topic]) {
        const child = await execa(cliExecutable, cliArguments("--no-input", "exec", ...args), {
          cwd,
          input: "piped",
        });
        expect(child.stdout.split("\n")).toEqual([
          JSON.stringify([topic, "--json", "-C", "two words", "", "--"]),
          "piped",
        ]);
      }
      await execa(cliExecutable, cliArguments("create", "other"), { cwd: workspace });
      const ambiguous = await tty(workspace, "exec", "--no-input", "--", "node", "--version");
      expect(ambiguous.exitCode).toBe(1);
      expect(ambiguous.stderr).toContain("Specify a worktree");
      expect((await tty(topic, "exec", "--no-input", "--", "node", "--version")).exitCode).toBe(0);
    });

    it("rejects missing tool choices before creating branches or checkouts", async () => {
      await execa(cliExecutable, cliArguments("create", "topic"), { cwd: workspace });
      const topic = path.join(workspace, "topic");
      for (const command of ["create", "handoff"]) {
        const result = await tty(topic, command, "probe", "--no-input", "--open");
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("--tool");
        await expect(fs.stat(path.join(workspace, "probe"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect((await execa("git", ["branch", "--list", "probe"], { cwd: topic })).stdout).toBe("");
      }
    });

    it("requires trust, gives configured tasks EOF, and preserves explicit exec input", async () => {
      await execa(cliExecutable, cliArguments("create", "topic"), { cwd: workspace });
      await fs.writeFile(
        path.join(workspace, ".wald/project.yml"),
        JSON.stringify({
          version: 1,
          tasks: {
            check: {
              steps: [
                {
                  type: "command",
                  argv: [
                    "node",
                    "-e",
                    "process.stdin.resume().on('end', () => console.log('stdin-closed'))",
                  ],
                },
              ],
            },
          },
        }),
      );
      const args = ["run", "check", "topic", "--no-input"];
      const refused = await tty(workspace, ...args);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("wald config trust");
      await execa(cliExecutable, cliArguments("config", "trust", "--yes"), { cwd: workspace });
      const task = await tty(workspace, ...args);
      expect(task.exitCode, task.stderr).toBe(0);
      expect(task.stderr).toMatch(/^stdin-closed$/mu);

      const child = await execa(
        cliExecutable,
        cliArguments(
          "--no-input",
          "exec",
          "topic",
          "--",
          "node",
          "-e",
          "process.stdin.pipe(process.stdout); console.log(process.argv[1])",
          "--",
          "--no-input",
        ),
        { cwd: workspace, input: "piped data" },
      );
      expect(child.stdout).toBe("--no-input\npiped data");
    });
  },
);
