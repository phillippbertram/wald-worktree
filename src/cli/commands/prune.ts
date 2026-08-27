import type { Command } from "commander";
import { z } from "zod";
import { YggError } from "../../domain/errors.js";
import type { Worktree } from "../../domain/types.js";
import { style } from "../../ui/style.js";
import { confirm, isInteractiveTerminal } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { success, writeLine } from "../helpers.js";
import { parseCliInput } from "../input.js";

const pruneInputSchema = z
  .object({
    apply: z.boolean().default(false),
    yes: z.boolean().default(false),
    json: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.yes && !value.apply) {
      context.addIssue({
        code: "custom",
        path: ["yes"],
        message: "Requires --apply.",
      });
    }
  });

export type PruneInput = z.output<typeof pruneInputSchema>;

export function registerPruneCommand(program: Command, context: CliContext): void {
  program
    .command("prune")
    .description("Preview or remove stale Git worktree metadata")
    .option("--apply", "Remove the stale metadata after previewing it")
    .option("--yes", "Confirm pruning without prompting; requires --apply")
    .option("--json", "Print machine-readable preview or result")
    .action(async (options: unknown) => {
      await pruneWorktrees(parseCliInput(pruneInputSchema, options), context);
    });
}

export async function pruneWorktrees(input: PruneInput, context: CliContext): Promise<void> {
  const workspace = await context.workspaces.find();
  const candidates = await context.worktrees.listPrunable(workspace);
  if (candidates.length === 0) {
    if (input.json) {
      writePruneJson(context.output.stdout, "none", candidates);
    } else {
      writeLine(context.output.stdout, "No stale worktree metadata found.");
    }
    return;
  }

  if (!input.json) printPrunePreview(candidates, context.output.stdout);
  if (!input.apply) {
    if (input.json) writePruneJson(context.output.stdout, "preview", candidates);
    else {
      writeLine(
        context.output.stdout,
        `${style.warning("Preview only.")} Run ${style.command("ygg prune --apply")} to remove this metadata.`,
      );
    }
    return;
  }

  if (!input.yes) {
    if (!isInteractiveTerminal()) {
      throw new YggError("Non-interactive pruning requires --apply --yes.");
    }
    const accepted = await confirm(
      `Prune metadata for ${candidates.map((worktree) => style.worktree(worktree.name)).join(", ")}?`,
    );
    if (!accepted) {
      writeLine(context.output.stdout, "Cancelled.");
      return;
    }
  }

  await context.worktrees.prune(workspace);
  const remaining = new Set(
    (await context.worktrees.listPrunable(workspace)).map((worktree) => worktree.path),
  );
  const removed = candidates.filter((worktree) => !remaining.has(worktree.path));
  if (input.json) writePruneJson(context.output.stdout, "applied", removed);
  else {
    await success(
      `Pruned ${style.value(removed.length)} stale worktree ${removed.length === 1 ? "registration" : "registrations"}. Branches and directories were not removed.`,
      context.output,
    );
  }
}

function writePruneJson(
  stream: NodeJS.WritableStream,
  action: "none" | "preview" | "applied",
  worktrees: Worktree[],
): void {
  writeLine(
    stream,
    JSON.stringify({
      action,
      worktrees: worktrees.map(({ name, branch, path: worktreePath }) => ({
        name,
        branch,
        path: worktreePath,
      })),
    }),
  );
}

function printPrunePreview(worktrees: Worktree[], stream: NodeJS.WritableStream): void {
  writeLine(stream, style.heading("Stale worktree metadata:"));
  for (const worktree of worktrees) {
    writeLine(
      stream,
      `- ${style.worktree(worktree.name)}\t${style.branch(worktree.branch ?? "detached")}\t${style.path(worktree.path)}`,
    );
  }
}
