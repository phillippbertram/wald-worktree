import type { Command } from "commander";
import { z } from "zod";
import { YggError } from "../../domain/errors.js";
import type { Worktree } from "../../domain/types.js";
import { style } from "../../ui/style.js";
import { confirm, isInteractiveTerminal } from "../../ui/terminal.js";
import type { CliContext } from "../context.js";
import { success, writeLine } from "../helpers.js";
import { parseCliInput } from "../input.js";

const uninitInputSchema = z
  .object({
    apply: z.boolean().default(false),
    force: z.boolean().default(false),
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
    if (value.force && !value.apply) {
      context.addIssue({
        code: "custom",
        path: ["force"],
        message: "Requires --apply.",
      });
    }
  });

export type UninitInput = z.output<typeof uninitInputSchema>;

export function registerUninitCommand(program: Command, context: CliContext): void {
  program
    .command("uninit")
    .description("Preview or remove Ygg workspace metadata while keeping the Git repository")
    .option("--apply", "Remove Ygg workspace metadata after previewing it")
    .option("--force", "Discard local data stored below the Ygg metadata directory")
    .option("--yes", "Confirm uninitialization without prompting; requires --apply")
    .option("--json", "Print machine-readable preview or result")
    .action(async (options: unknown) => {
      await uninitializeWorkspace(parseCliInput(uninitInputSchema, options), context);
    });
}

export async function uninitializeWorkspace(
  input: UninitInput,
  context: CliContext,
): Promise<boolean> {
  const workspace = await context.workspaces.find();
  const inspection = await context.workspaces.inspectUninitialization(workspace);
  const blockingWorktrees = (await context.worktrees.list(workspace)).filter(
    (worktree) => worktree.role !== "primary",
  );

  if (!input.json) {
    printUninitializationPreview(workspace, inspection, blockingWorktrees, context.output.stdout);
  }
  if (!input.apply) {
    if (input.json) {
      writeUninitJson(context.output.stdout, "preview", workspace, inspection, blockingWorktrees);
    } else {
      writeLine(
        context.output.stdout,
        `${style.warning("Preview only.")} Run ${style.command("ygg uninit --apply")} to remove the Ygg workspace metadata.`,
      );
    }
    return false;
  }

  if (blockingWorktrees.length > 0) {
    throw new YggError(
      `Registered worktrees remain: ${blockingWorktrees.map((worktree) => worktree.name).join(", ")}. Remove existing worktrees or prune missing registrations first.`,
    );
  }
  if (inspection.dataEntries.length > 0 && !input.force) {
    throw new YggError(
      "Ygg metadata contains local data. Use --force only if this data can be discarded.",
    );
  }
  if (!input.yes) {
    if (!isInteractiveTerminal()) {
      throw new YggError("Non-interactive uninitialization requires --apply --yes.");
    }
    const accepted = await confirm(
      `Uninitialize Ygg at ${style.path(workspace.root)}? The Git repository, branches, and worktree directory will be kept.`,
    );
    if (!accepted) {
      writeLine(context.output.stdout, "Cancelled.");
      return false;
    }
  }

  const latestWorktrees = (await context.worktrees.list(workspace)).filter(
    (worktree) => worktree.role !== "primary",
  );
  if (latestWorktrees.length > 0) {
    throw new YggError(
      "Registered worktrees changed during uninitialization. Run ygg uninit again.",
    );
  }
  await context.workspaces.uninitialize(workspace, { force: input.force });
  if (input.json) {
    writeUninitJson(context.output.stdout, "applied", workspace, inspection, []);
  } else {
    await success(
      "Removed Ygg workspace metadata. The Git repository, branches, and worktree directory were kept.",
      context.output,
    );
  }
  return true;
}

function writeUninitJson(
  stream: NodeJS.WritableStream,
  action: "preview" | "applied",
  workspace: Awaited<ReturnType<CliContext["workspaces"]["find"]>>,
  inspection: Awaited<ReturnType<CliContext["workspaces"]["inspectUninitialization"]>>,
  blockingWorktrees: Worktree[],
): void {
  writeLine(
    stream,
    JSON.stringify({
      action,
      remove: [inspection.metadataDir, inspection.markerPath].filter(Boolean),
      keep: [workspace.gitDir, workspace.worktreeDir, workspace.primaryWorktree].filter(Boolean),
      blockingWorktrees: blockingWorktrees.map(({ name, path: worktreePath, state }) => ({
        name,
        path: worktreePath,
        state,
      })),
      dataEntries: inspection.dataEntries,
    }),
  );
}

function printUninitializationPreview(
  workspace: Awaited<ReturnType<CliContext["workspaces"]["find"]>>,
  inspection: Awaited<ReturnType<CliContext["workspaces"]["inspectUninitialization"]>>,
  blockingWorktrees: Worktree[],
  stream: NodeJS.WritableStream,
): void {
  writeLine(stream, style.heading("Ygg workspace metadata:"));
  writeLine(stream, `- ${style.danger("remove")}\t${style.path(inspection.metadataDir)}`);
  if (inspection.markerPath) {
    writeLine(stream, `- ${style.danger("remove")}\t${style.path(inspection.markerPath)}`);
  }
  writeLine(stream, `- ${style.success("keep Git database")}\t${style.path(workspace.gitDir)}`);
  writeLine(
    stream,
    `- ${style.success("keep worktree directory")}\t${style.path(workspace.worktreeDir)}`,
  );
  if (workspace.primaryWorktree) {
    writeLine(
      stream,
      `- ${style.success("keep primary checkout")}\t${style.path(workspace.primaryWorktree)}`,
    );
  }

  if (blockingWorktrees.length > 0) {
    writeLine(stream, style.warning("Registered worktrees must be removed or pruned first:"));
    for (const worktree of blockingWorktrees) {
      writeLine(
        stream,
        `- ${style.worktree(worktree.name)}\t${style.state(worktree.state, worktree.state)}\t${style.path(worktree.path)}`,
      );
    }
  }
  if (inspection.dataEntries.length > 0) {
    writeLine(stream, style.warning("Local data that --force would discard:"));
    for (const entry of inspection.dataEntries.slice(0, 20)) {
      writeLine(stream, `- ${style.path(entry)}`);
    }
    if (inspection.dataEntries.length > 20) {
      writeLine(stream, `- ... and ${inspection.dataEntries.length - 20} more entries`);
    }
  }
}
