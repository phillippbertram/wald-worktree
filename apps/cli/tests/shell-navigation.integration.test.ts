import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellQuote } from "../src/cli/helpers.js";
import { ShellService } from "../src/services/shell-service.js";
import { cliArguments, cliExecutable } from "./helpers/cli.js";
import { createTestRepository } from "./helpers/git-repository.js";

const availableShells: string[] = [];
for (const shell of ["bash", "zsh", "fish"]) {
  try {
    await execa(shell, ["--version"]);
    availableShells.push(shell);
  } catch {
    /* Optional shell is not installed. */
  }
}

describe("shell directory integration", { timeout: 30_000 }, () => {
  let root: string;
  let workspace: string;
  let bin: string;
  let integration: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wald-shell-directory-")));
    workspace = path.join(root, "workspace with spaces $(touch SHOULD_NOT_EXIST)");
    bin = path.join(root, "bin");
    integration = path.join(root, "integration");
    await fs.mkdir(bin);
    const repository = await createTestRepository(root);
    await execa(cliExecutable, cliArguments("init", repository.remote, workspace), { cwd: root });
    await execa(cliExecutable, cliArguments("-C", workspace, "create", "main", "--no-fetch"), {
      cwd: root,
    });
    await fs.symlink(workspace, path.join(root, "--cd"));
    await fs.writeFile(
      path.join(bin, "wald"),
      `#!/bin/sh\nexec ${[cliExecutable, ...cliArguments()].map(shellQuote).join(" ")} "$@"\n`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  const runShell = async (shell: string, script: string) => {
    const service = new ShellService();
    await fs.writeFile(integration, service.render(shell) + service.renderCompletion(shell));
    return execa(
      shell,
      [
        shell === "zsh" ? "-f" : shell === "fish" ? "--no-config" : "--noprofile",
        ...(shell === "bash" ? ["--norc"] : []),
        "-c",
        script,
      ],
      {
        cwd: root,
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          WALD_TEST_WORKSPACE: workspace,
          WALD_TEST_ROOT: root,
          WALD_TEST_INTEGRATION: integration,
        },
        reject: false,
      },
    );
  };

  for (const shell of ["bash", "zsh", "fish"]) {
    it.skipIf(!availableShells.includes(shell))(
      `preserves the parent directory unless navigation is requested in ${shell}`,
      async () => {
        const result = await runShell(
          shell,
          shell === "fish"
            ? `
source "$WALD_TEST_INTEGRATION"
wald -C "$WALD_TEST_WORKSPACE" status; or exit 2
test "$PWD" = "$WALD_TEST_ROOT"; or exit 3
wald -C --cd create feature/no-navigation --no-fetch; or exit 4
test "$PWD" = "$WALD_TEST_ROOT"; or exit 5
wald -C "$WALD_TEST_WORKSPACE" cd --help; or exit 6
test "$PWD" = "$WALD_TEST_ROOT"; or exit 7
wald -C "$WALD_TEST_WORKSPACE" cd main; or exit 8
test "$PWD" = "$WALD_TEST_WORKSPACE/main"; or exit 9
if wald -C missing cd main
  exit 10
end
test "$PWD" = "$WALD_TEST_WORKSPACE/main"; or exit 11
wald --directory="$WALD_TEST_WORKSPACE" create --no-fetch --cd -- feature/entered; or exit 12
test "$PWD" = "$WALD_TEST_WORKSPACE/feature-entered"; or exit 13
wald -C "$WALD_TEST_WORKSPACE" -C main handoff feature/carried --no-fetch --skip-hooks --cd; or exit 14
test "$PWD" = "$WALD_TEST_WORKSPACE/feature-carried"; or exit 15
printf 'NAVIGATION_OK\\n'
`
            : `
${shell === "zsh" ? "autoload -Uz compinit; compinit -D" : ""}
source "$WALD_TEST_INTEGRATION"
wald -C "$WALD_TEST_WORKSPACE" status || exit 2
[ "$PWD" = "$WALD_TEST_ROOT" ] || exit 3
wald -C --cd create feature/no-navigation --no-fetch || exit 4
[ "$PWD" = "$WALD_TEST_ROOT" ] || exit 5
wald -C "$WALD_TEST_WORKSPACE" cd --help || exit 6
[ "$PWD" = "$WALD_TEST_ROOT" ] || exit 7
wald -C "$WALD_TEST_WORKSPACE" cd main || exit 8
[ "$PWD" = "$WALD_TEST_WORKSPACE/main" ] || exit 9
if wald -C missing cd main; then exit 10; fi
[ "$PWD" = "$WALD_TEST_WORKSPACE/main" ] || exit 11
wald --directory="$WALD_TEST_WORKSPACE" create --no-fetch --cd -- feature/entered || exit 12
[ "$PWD" = "$WALD_TEST_WORKSPACE/feature-entered" ] || exit 13
wald -C "$WALD_TEST_WORKSPACE" -C main handoff feature/carried --no-fetch --skip-hooks --cd || exit 14
[ "$PWD" = "$WALD_TEST_WORKSPACE/feature-carried" ] || exit 15
printf 'NAVIGATION_OK\\n'
`,
        );
        expect(result.exitCode, result.stderr + result.stdout).toBe(0);
        expect(result.stdout).toContain("NAVIGATION_OK");
        await expect(fs.access(path.join(root, "SHOULD_NOT_EXIST"))).rejects.toThrow();
      },
    );
  }

  it.skipIf(!availableShells.includes("bash"))(
    "passes Bash completion arguments literally, including spaces and command substitution text",
    async () => {
      const result = await runShell(
        "bash",
        `
source "$WALD_TEST_INTEGRATION"
printf -v wald_quoted '%q' "$WALD_TEST_WORKSPACE"
COMP_WORDS=(wald -C "$wald_quoted" open '')
COMP_CWORD=4
__wald_complete
printf 'CANDIDATE=%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(wald '--directory=workspace')
COMP_CWORD=1
__wald_complete
printf 'DIRECTORY=%s\\n' "\${COMPREPLY[@]}"
`,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("CANDIDATE=main");
      expect(result.stdout).toContain("DIRECTORY=workspace with spaces $(touch SHOULD_NOT_EXIST)/");
      expect(result.stdout).not.toContain("DIRECTORY=--directory=");
      await expect(fs.access(path.join(root, "SHOULD_NOT_EXIST"))).rejects.toThrow();
    },
  );

  it.skipIf(!availableShells.includes("zsh"))(
    "passes Zsh completion arguments literally and returns the selected workspace's candidates",
    async () => {
      const result = await runShell(
        "zsh",
        `
compdef() { :; }
_describe() { print -rl -- "\${wald_values[@]}"; }
compadd() { print -rl -- "\${wald_directories[@]}"; }
source "$WALD_TEST_INTEGRATION"
words=(wald -C "$WALD_TEST_WORKSPACE" open '')
CURRENT=5
_wald
`,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("main:main (clean)");
      await expect(fs.access(path.join(root, "SHOULD_NOT_EXIST"))).rejects.toThrow();
    },
  );
});
