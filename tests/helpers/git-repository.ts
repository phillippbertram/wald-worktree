import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export type TestRepository = {
  remote: string;
  source: string;
};

export async function createTestRepository(root: string): Promise<TestRepository> {
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");

  await runGit(["init", "--bare", remote]);
  await runGit(["init", "-b", "main", source]);
  await runGit(["config", "user.email", "tests@example.invalid"], source);
  await runGit(["config", "user.name", "wald tests"], source);
  await fs.writeFile(path.join(source, "README.md"), "# fixture\n", "utf8");
  await fs.writeFile(
    path.join(source, ".gitignore"),
    [".env", ".env.*", "node_modules/", "dist/", "build/", "coverage/", "fixtures/", ""].join("\n"),
    "utf8",
  );
  await runGit(["add", "README.md", ".gitignore"], source);
  await runGit(["commit", "-m", "initial"], source);
  await runGit(["remote", "add", "origin", remote], source);
  await runGit(["push", "-u", "origin", "main"], source);
  await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], remote, true);

  return { remote, source };
}

export async function createRemoteBranch(
  repository: TestRepository,
  branch: string,
): Promise<void> {
  await runGit(["switch", "-c", branch], repository.source);
  await runGit(["push", "-u", "origin", branch], repository.source);
  await runGit(["switch", "main"], repository.source);
}

async function runGit(args: string[], cwd?: string, gitDir = false): Promise<void> {
  const commandArgs = gitDir ? [`--git-dir=${cwd}`, ...args] : args;
  await execa("git", commandArgs, { cwd: gitDir ? undefined : cwd });
}
