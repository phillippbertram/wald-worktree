import { WaldError } from "../domain/errors.js";
import type { Worktree } from "../domain/types.js";
import { redactSensitiveText, sanitizeTerminalText } from "../infrastructure/safe-text.js";
import { style } from "../ui/style.js";
import { isPromptBackError, selectValue } from "../ui/terminal.js";
import { openWorktree } from "./commands/open.js";
import type { CliContext } from "./context.js";
import { shellQuote, writeLine } from "./helpers.js";

export type MenuResult = "back" | "exit";

export function reportMenuError(error: unknown, context: CliContext): void {
  if (!(error instanceof WaldError) || error.exitCode === 130) throw error;
  writeLine(
    context.output.stderr,
    `${style.danger("Error:")} ${sanitizeTerminalText(redactSensitiveText(error.message), { multiline: true })}`,
  );
}

export function showNavigation(worktree: Worktree, context: CliContext): void {
  writeLine(
    context.output.stdout,
    `${style.label("Enter with shell integration:")} ${style.command(`wald cd ${shellQuote(worktree.path)}`)}`,
  );
  writeLine(
    context.output.stdout,
    `${style.label("Or run:")} ${style.command(`cd ${shellQuote(worktree.path)}`)}`,
  );
}

export async function showMenuResult(
  context: CliContext,
  backLabel = "Back to main menu",
  worktree?: Worktree | null,
): Promise<MenuResult> {
  while (true) {
    try {
      const next = await selectValue(
        "What next?",
        [
          ...(worktree
            ? [
                {
                  label: `Open ${style.worktree(worktree.name)}`,
                  value: "open",
                  description: "Choose an editor or agent.",
                },
                { label: "Show navigation command", value: "navigate" },
              ]
            : []),
          { label: backLabel, value: "back" },
          { label: "Exit", value: "exit", description: "Close the interactive Wald session." },
        ],
        { navigation: "back", initialValue: "back" },
      );
      if (next === "back" || next === "exit") return next;
      if (worktree && next === "navigate") showNavigation(worktree, context);
      if (worktree && next === "open") {
        try {
          await openWorktree(worktree.path, undefined, context);
        } catch (error) {
          if (!isPromptBackError(error)) reportMenuError(error, context);
        }
      }
    } catch (error) {
      if (isPromptBackError(error)) return "back";
      throw error;
    }
  }
}
