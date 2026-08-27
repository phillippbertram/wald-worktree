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
  isPromptBackError,
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
  let templateOptions = options.yes ? detectedDefaults(inspection) : undefined;
  let promptState: TemplatePromptState | undefined;
  let resumeAtLastStep = false;

  while (!templateOptions) {
    const prompted = await promptForTemplate(inspection, promptState, resumeAtLastStep);
    promptState = prompted.state;
    templateOptions = prompted.options;
    const config = context.projectConfigs.createConfig(inspection, templateOptions);

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
    try {
      if (!(await confirm(`Write ${projectConfigFileName}?`, true, { navigation: "back" }))) {
        writeLine(context.output.stdout, "Cancelled.");
        return null;
      }
    } catch (error) {
      if (!isPromptBackError(error)) throw error;
      templateOptions = undefined;
      resumeAtLastStep = true;
    }
  }

  const config = context.projectConfigs.createConfig(inspection, templateOptions);

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
  initialState: TemplatePromptState | undefined,
  resumeAtLastStep: boolean,
): Promise<{ options: ProjectConfigTemplateOptions; state: TemplatePromptState }> {
  const verificationScripts = inspection.scripts.filter(
    (script) => script !== inspection.developmentScript,
  );
  const steps: TemplateStep[] = [
    "fetch",
    ...(inspection.installCommand ? (["install"] as const) : []),
    ...(inspection.environmentExample ? (["environment"] as const) : []),
    ...(inspection.developmentScript ? (["development"] as const) : []),
    ...(verificationScripts.length > 0 ? (["verification", "scripts"] as const) : []),
    "tool",
  ];
  const state: TemplatePromptState = { ...initialState };
  let index = resumeAtLastStep ? steps.length - 1 : 0;
  while (index < steps.length) {
    const step = steps[index] as TemplateStep;
    const navigation = index === 0 ? "cancel" : "back";
    try {
      switch (step) {
        case "fetch":
          state.fetch = await confirm(
            "Configure › Repository · Fetch before resolving branches by default?",
            state.fetch ?? true,
            { navigation },
          );
          break;
        case "install":
          state.install = await confirm(
            `Configure › Setup · Run '${inspection.installCommand?.join(" ")}' after creating a worktree?`,
            state.install ?? true,
            { navigation },
          );
          break;
        case "environment":
          state.copyEnvironment = await confirm(
            `Configure › Setup · Copy ${inspection.environmentExample} to .env after creation?`,
            state.copyEnvironment ?? true,
            { navigation },
          );
          break;
        case "development":
          state.development = await confirm(
            "Configure › Tasks · Create a 'dev' task from the detected package script?",
            state.development ?? true,
            { navigation },
          );
          break;
        case "verification":
          state.createVerification = await confirm(
            "Configure › Tasks · Create a 'verify' task from detected package scripts?",
            state.createVerification ?? true,
            { navigation },
          );
          if (!state.createVerification) state.scripts = [];
          break;
        case "scripts":
          if (!state.createVerification) {
            index += 1;
            continue;
          }
          state.scripts = await selectManyValues(
            "Configure › Tasks · Select package scripts for the verify task:",
            verificationScripts.map((script) => ({
              label: script,
              value: script,
              checked: inspection.recommendedScripts.includes(script),
            })),
            {
              navigation,
              initialValues: state.scripts ?? inspection.recommendedScripts,
            },
          );
          break;
        case "tool":
          state.tool = await selectValue(
            "Configure › Tool · Default editor or agent:",
            [
              { label: "No default", value: "__none__" },
              { label: "Visual Studio Code", value: "code" },
              { label: "Cursor", value: "cursor" },
              { label: "Zed", value: "zed" },
              { label: "Codex CLI", value: "codex" },
              { label: "Codex desktop app", value: "codex-app" },
              { label: "Claude Code", value: "claude" },
            ],
            { navigation, initialValue: state.tool ?? "__none__" },
          );
          break;
      }
      index += 1;
    } catch (error) {
      if (!isPromptBackError(error) || index === 0) throw error;
      index -= 1;
      if (steps[index] === "scripts" && !state.createVerification) index -= 1;
    }
  }
  return {
    options: {
      fetch: state.fetch ?? true,
      install: state.install ?? false,
      copyEnvironment: state.copyEnvironment ?? false,
      scripts: state.createVerification ? (state.scripts ?? []) : [],
      development: state.development ?? false,
      tool: state.tool && state.tool !== "__none__" ? state.tool : undefined,
    },
    state,
  };
}

type TemplateStep =
  | "fetch"
  | "install"
  | "environment"
  | "development"
  | "verification"
  | "scripts"
  | "tool";

type TemplatePromptState = {
  fetch?: boolean;
  install?: boolean;
  copyEnvironment?: boolean;
  development?: boolean;
  createVerification?: boolean;
  scripts?: string[];
  tool?: string;
};

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
