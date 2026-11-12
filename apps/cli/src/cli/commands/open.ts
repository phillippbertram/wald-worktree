import type { Command } from "commander";
import { z } from "zod";
import { toErrorMessage, WaldError } from "../../domain/errors.js";
import type { ProjectConfigDocument, Worktree } from "../../domain/types.js";
import { builtInToolNames } from "../../services/tool-service.js";
import { style } from "../../ui/style.js";
import {
  isInteractiveTerminal,
  isPromptBackError,
  type PromptNavigation,
  searchSelect,
} from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { ensureTrusted, resolveWorktree, success } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const openInputSchema = z
  .object({
    worktree: nonEmptyCliString.optional(),
    tool: nonEmptyCliString.optional(),
  })
  .strict();

export function registerOpenCommand(program: Command, context: CliContext): void {
  program
    .command("open")
    .description("Open a worktree in an editor, app, or agent tool")
    .argument("[worktree]", "Worktree name, branch, or path")
    .option("--tool <profile>", "Tool profile from built-ins or project configuration")
    .addHelpText(
      "after",
      `\nBuilt-in tools: ${builtInToolNames.join(", ")}\n\nExamples:\n  wald open feature-payment --tool code\n  wald open feature-payment --tool codex\n`,
    )
    .action(async (worktree: unknown, options: unknown) => {
      const input = parseCliInput(openInputSchema, { worktree, ...(options as object) });
      await openWorktree(input.worktree, input.tool, context);
    });
}

export async function openWorktree(
  requestedWorktree: string | undefined,
  requestedTool: string | undefined,
  context: CliContext,
): Promise<void> {
  const workspace = await context.workspaces.find();
  const canChooseWorktree =
    !requestedWorktree && (await context.worktrees.list(workspace)).length > 1;
  let forcePrompt = false;
  let initialPath: string | undefined;
  while (true) {
    const selected = await resolveWorktree(workspace, requestedWorktree, context.worktrees, {
      forcePrompt,
      initialPath,
      navigation: forcePrompt ? "cancel" : undefined,
    });
    initialPath = selected.path;
    try {
      await openSelectedWorktree(selected, requestedTool, context, {
        promptNavigation: canChooseWorktree ? "back" : "cancel",
      });
      return;
    } catch (error) {
      if (!isPromptBackError(error) || !canChooseWorktree || requestedTool) throw error;
      forcePrompt = true;
    }
  }
}

export async function openSelectedWorktree(
  worktree: Worktree,
  requestedTool: string | undefined,
  context: CliContext,
  options: {
    silent?: boolean;
    project?: ProjectConfigDocument | null;
    promptNavigation?: PromptNavigation;
  } = {},
): Promise<void> {
  const workspace = await context.workspaces.find();
  const project =
    options.project === undefined
      ? await context.workflow.projectForWorktree(workspace, worktree)
      : options.project;
  const available = await context.tools.availableProfiles(project, worktree);
  if (available.length === 0)
    throw new WaldError("No supported editor or agent tool is available.");
  let tool = requestedTool ?? project?.config.defaults.tool;
  const promptForTool = !tool;
  while (true) {
    if (!tool) {
      if (!isInteractiveTerminal()) {
        throw new WaldError("Tool is required without a TTY. Use --tool.");
      }
      tool = await searchSelect(
        `Open › Tool · Open ${style.worktree(worktree.name)} with:`,
        available.map(({ name, profile }) => ({
          label: style.value(name),
          value: name,
          description: profile.description,
        })),
        { navigation: options.promptNavigation ?? "cancel", initialValue: tool },
      );
    }
    try {
      await ensureTrusted(workspace, project, context, {
        navigation: promptForTool ? "back" : "cancel",
      });
      break;
    } catch (error) {
      if (!isPromptBackError(error) || !promptForTool) throw error;
      tool = undefined;
    }
  }
  if (!tool) throw new WaldError("No tool selected.");
  try {
    await context.tools.open(worktree, tool, project);
  } catch (error) {
    throw new WaldError(`Could not open ${worktree.name} with ${tool}: ${toErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!options.silent) {
    await success(
      `Opened ${style.worktree(worktree.name)} with ${style.value(tool)}`,
      context.output,
    );
  }
}
