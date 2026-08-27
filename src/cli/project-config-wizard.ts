import fs from "node:fs/promises";
import path from "node:path";
import { YggError } from "../domain/errors.js";
import type { ProjectConfigDocument } from "../domain/types.js";
import { projectConfigFileName } from "../services/config-service.js";
import type {
  ProjectConfigTemplateOptions,
  ProjectSetupInspection,
} from "../services/project-config-initializer.js";
import {
  confirm,
  isInteractiveTerminal,
  printKeyValueTable,
  runTask,
  selectManyValues,
  selectValue,
} from "../ui/terminal.js";
import type { CliContext } from "./context.js";
import { success, writeLine } from "./helpers.js";

export async function initializeProjectConfiguration(
  root: string,
  options: { force: boolean; yes: boolean },
  context: CliContext,
): Promise<ProjectConfigDocument | null> {
  if (!options.yes && !isInteractiveTerminal()) {
    throw new YggError("Non-interactive configuration initialization requires --yes.");
  }

  const configPath = path.join(root, projectConfigFileName);
  const exists = await fileExists(configPath);
  let overwrite = options.force;
  if (exists && !overwrite) {
    if (options.yes || !isInteractiveTerminal()) {
      throw new YggError(
        `Project configuration already exists: ${configPath}. Use --force to replace it.`,
      );
    }
    overwrite = await confirm(`Replace the existing ${projectConfigFileName}?`);
    if (!overwrite) {
      writeLine(context.output.stdout, "Cancelled.");
      return null;
    }
  }

  const inspection = await runTask("Inspecting project", () =>
    context.projectConfigs.inspect(root),
  );
  const templateOptions = options.yes
    ? detectedDefaults(inspection)
    : await promptForTemplate(inspection);
  const config = context.projectConfigs.createConfig(inspection, templateOptions);

  if (!options.yes) {
    await printKeyValueTable([
      ["Package manager", inspection.packageManager ?? "none"],
      ["Install hook", templateOptions.install ? "yes" : "no"],
      ["Environment copy", templateOptions.copyEnvironment ? "yes" : "no"],
      ["Verify scripts", templateOptions.scripts.join(", ") || "none"],
      ["Development task", templateOptions.development ? "dev" : "none"],
      ["Default tool", templateOptions.tool ?? "none"],
    ]);
    writeLine(context.output.stdout, "");
    context.output.stdout.write(context.configs.formatProjectConfig(config));
    if (!(await confirm(`Write ${projectConfigFileName}?`, true))) {
      writeLine(context.output.stdout, "Cancelled.");
      return null;
    }
  }

  const document = await runTask(`Writing ${projectConfigFileName}`, () =>
    context.configs.writeProjectConfig(inspection.root, config, { overwrite }),
  );
  await success(`Created ${document.path}`, context.output);
  writeLine(
    context.output.stdout,
    `Next: review and commit ${projectConfigFileName} on the branch used to create future worktrees.`,
  );
  if (document.requiresTrust) {
    writeLine(context.output.stdout, "Then: ygg config trust");
  }
  return document;
}

async function promptForTemplate(
  inspection: ProjectSetupInspection,
): Promise<ProjectConfigTemplateOptions> {
  const fetch = await confirm("Fetch before resolving branches by default?", true);
  const install = inspection.installCommand
    ? await confirm(`Run '${inspection.installCommand.join(" ")}' after creating a worktree?`, true)
    : false;
  const copyEnvironment = inspection.environmentExample
    ? await confirm(`Copy ${inspection.environmentExample} to .env after creation?`, true)
    : false;
  const development = inspection.developmentScript
    ? await confirm("Create a 'dev' task from the detected package script?", true)
    : false;
  const verificationScripts = inspection.scripts.filter(
    (script) => script !== inspection.developmentScript,
  );
  const scripts =
    verificationScripts.length > 0
      ? await selectManyValues(
          "Select package scripts for the verify task:",
          verificationScripts.map((script) => ({
            label: script,
            value: script,
            checked: inspection.recommendedScripts.includes(script),
          })),
        )
      : [];
  const selectedTool = await selectValue("Default editor or agent:", [
    { label: "No default", value: "__none__" },
    { label: "Visual Studio Code", value: "code" },
    { label: "Cursor", value: "cursor" },
    { label: "Zed", value: "zed" },
    { label: "Codex CLI", value: "codex" },
    { label: "Codex desktop app", value: "codex-app" },
    { label: "Claude Code", value: "claude" },
  ]);
  return {
    fetch,
    install,
    copyEnvironment,
    scripts,
    development,
    tool: selectedTool && selectedTool !== "__none__" ? selectedTool : undefined,
  };
}

function detectedDefaults(inspection: ProjectSetupInspection): ProjectConfigTemplateOptions {
  return {
    fetch: true,
    install: Boolean(inspection.installCommand),
    copyEnvironment: Boolean(inspection.environmentExample),
    scripts: inspection.recommendedScripts,
    development: Boolean(inspection.developmentScript),
  };
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
