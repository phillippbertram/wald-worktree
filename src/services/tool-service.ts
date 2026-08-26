import fs from "node:fs/promises";
import path from "node:path";
import { WtError } from "../domain/errors.js";
import type { ProjectConfigDocument, ToolProfile, Worktree } from "../domain/types.js";
import { ProcessRunner } from "../infrastructure/process-runner.js";

const builtInTools: Record<string, ToolProfile> = {
  code: {
    description: "Visual Studio Code",
    command: ["code", "."],
    mode: "detached",
  },
  cursor: {
    description: "Cursor",
    command: ["cursor", "."],
    mode: "detached",
  },
  zed: {
    description: "Zed",
    command: ["zed", "."],
    mode: "detached",
  },
  codex: {
    description: "Codex CLI",
    command: ["codex"],
    mode: "foreground",
  },
  "codex-app": {
    description: "Codex desktop app",
    command: ["codex", "app", "."],
    mode: "detached",
  },
  claude: {
    description: "Claude Code",
    command: ["claude"],
    mode: "foreground",
  },
};

export class ToolService {
  constructor(private readonly processes = new ProcessRunner()) {}

  profiles(project: ProjectConfigDocument | null): Record<string, ToolProfile> {
    return { ...builtInTools, ...(project?.config.tools ?? {}) };
  }

  async availableProfiles(
    project: ProjectConfigDocument | null,
  ): Promise<Array<{ name: string; profile: ToolProfile }>> {
    const profiles = this.profiles(project);
    const checks = await Promise.all(
      Object.entries(profiles).map(async ([name, profile]) => ({
        name,
        profile,
        available: await commandExists(profile.command[0] as string),
      })),
    );
    return checks
      .filter((candidate) => candidate.available)
      .map(({ name, profile }) => ({ name, profile }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async open(
    worktree: Worktree,
    toolName: string,
    project: ProjectConfigDocument | null,
  ): Promise<void> {
    const profile = this.profiles(project)[toolName];
    if (!profile) {
      throw new WtError(`Unknown tool profile: ${toolName}`);
    }
    if (!(await commandExists(profile.command[0] as string))) {
      throw new WtError(`Tool is not available in PATH: ${profile.command[0]}`);
    }
    const command = profile.command.map((argument) => argument.replaceAll("{path}", worktree.path));
    if (profile.mode === "detached") {
      await this.processes.launchDetached(command, worktree.path);
    } else {
      await this.processes.runInteractive(command, worktree.path);
    }
  }
}

async function commandExists(command: string): Promise<boolean> {
  if (command.includes(path.sep)) {
    try {
      await fs.access(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const searchPath = process.env.PATH;
  if (!searchPath) {
    return false;
  }
  for (const directory of searchPath.split(path.delimiter)) {
    try {
      await fs.access(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}
