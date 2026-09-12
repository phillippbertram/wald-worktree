import type { Command } from "commander";
import { z } from "zod";
import { WaldError } from "../../domain/errors.js";
import { type HookEvent, hookEvents } from "../../domain/types.js";
import { style } from "../../ui/style.js";
import { isInteractiveTerminal, isPromptBackError, searchSelect } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { ensureTrusted, resolveWorktree, success, writeLine } from "../helpers.js";
import { nonEmptyCliString, parseCliInput } from "../input.js";

const hookRunInputSchema = z
  .object({
    event: z.enum(hookEvents).optional(),
    worktree: nonEmptyCliString.optional(),
  })
  .strict();

export type HookRunInput = z.output<typeof hookRunInputSchema>;

type HookRunPresentation = {
  emptyMessage?: (event: HookEvent, worktreeName: string) => string;
  successMessage?: (event: HookEvent, worktreeName: string) => string;
};

export function registerHookCommand(program: Command, context: CliContext): void {
  const hook = program.command("hook").description("Run project lifecycle hooks manually");
  const run = hook
    .command("run")
    .description("Run one effective project-configuration hook without changing Git state")
    .argument("<event>", "Lifecycle hook to run")
    .argument("[worktree]", "Worktree name, branch, or path")
    .addHelpText(
      "after",
      "\nExamples:\n  wald hook run post_create feature-payment\n  wald hook run pre_remove feature-payment\n",
    )
    .action(async (event: unknown, worktree: unknown) => {
      await runProjectHook(parseCliInput(hookRunInputSchema, { event, worktree }), context);
    });

  const eventArgument = run.registeredArguments[0];
  if (!eventArgument) throw new Error("Hook run command is missing its event argument.");
  eventArgument.choices([...hookEvents]);
}

export async function runProjectHook(
  input: HookRunInput,
  context: CliContext,
  presentation: HookRunPresentation = {},
): Promise<void> {
  const workspace = await context.workspaces.find();
  const canChooseWorktree = !input.worktree && (await context.worktrees.list(workspace)).length > 1;
  let forcePrompt = false;
  let initialPath: string | undefined;
  let selectedEvent: HookEvent | undefined;

  while (true) {
    const worktree = await resolveWorktree(workspace, input.worktree, context.worktrees, {
      forcePrompt,
      initialPath,
      navigation: forcePrompt ? "cancel" : undefined,
    });
    initialPath = worktree.path;
    const project = await context.workflow.projectForWorktree(workspace, worktree);
    if (!project) throw new WaldError(`No project configuration found for ${worktree.path}`);
    const configuredEvents = hookEvents.filter((event) => project.config.hooks[event].length > 0);
    if (configuredEvents.length === 0 && !input.event) {
      throw new WaldError("No hooks are configured in the effective project configuration.");
    }

    while (true) {
      let event: HookEvent;
      if (input.event) {
        event = input.event;
      } else {
        if (!isInteractiveTerminal()) throw new WaldError("Hook event is required without a TTY.");
        try {
          event = z.enum(hookEvents).parse(
            await searchSelect(
              `Hook › Event · Select a hook for ${style.worktree(worktree.name)}:`,
              configuredEvents.map((configuredEvent) => ({
                label: style.value(configuredEvent),
                value: configuredEvent,
                description: hookDescription(configuredEvent),
              })),
              {
                navigation: canChooseWorktree ? "back" : "cancel",
                initialValue: selectedEvent,
              },
            ),
          );
          selectedEvent = event;
        } catch (error) {
          if (!isPromptBackError(error) || !canChooseWorktree) throw error;
          forcePrompt = true;
          break;
        }
      }

      if (project.config.hooks[event].length === 0) {
        throw new WaldError(
          presentation.emptyMessage?.(event, worktree.name) ??
            `No ${event} hook is configured for ${worktree.name}.`,
        );
      }
      try {
        await ensureTrusted(workspace, project, context, {
          navigation: input.event ? "cancel" : "back",
        });
      } catch (error) {
        if (!isPromptBackError(error) || input.event) throw error;
        continue;
      }

      writeManualContextWarning(event, worktree.name, context);
      await context.workflow.runHook(workspace, worktree, event, {
        output: context.output.stderr,
      });
      await success(
        presentation.successMessage?.(event, worktree.name) ??
          `Completed ${style.value(event)} hook for ${style.worktree(worktree.name)}`,
        context.output,
      );
      return;
    }
  }
}

function hookDescription(event: HookEvent): string {
  switch (event) {
    case "pre_create":
      return "Run pre-create steps without creating a worktree.";
    case "post_create":
      return "Re-run setup steps in an existing worktree.";
    case "pre_remove":
      return "Run pre-remove steps without removing the worktree.";
    case "post_remove":
      return "Run post-remove steps while the worktree still exists.";
  }
}

function writeManualContextWarning(
  event: HookEvent,
  worktreeName: string,
  context: CliContext,
): void {
  if (event === "pre_create") {
    writeLine(
      context.output.stderr,
      `${style.warning("Warning:")} Manual ${style.value("pre_create")} runs against existing worktree ${style.worktree(worktreeName)}; it does not create a worktree.`,
    );
  }
  if (event === "post_remove") {
    writeLine(
      context.output.stderr,
      `${style.warning("Warning:")} Manual ${style.value("post_remove")} keeps existing worktree ${style.worktree(worktreeName)}; it does not remove a worktree.`,
    );
  }
}
