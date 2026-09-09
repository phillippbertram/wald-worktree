import type { CreatePlan } from "../services/worktree-workflow-service.js";
import { style } from "./style.js";
import { renderTable } from "./table.js";

export type CreateDestination =
  | { type: "stay" }
  | { type: "cd" }
  | { type: "open"; tool: string | null };

export function printCreatePlan(
  plan: CreatePlan,
  destination: CreateDestination,
  output: { stdout: NodeJS.WritableStream },
  title = "Create plan",
): void {
  const rows: Array<[string, string]> = [
    ["Branch", plan.prepared.branch],
    ["Strategy", strategyLabel(plan)],
    ["Starting ref", startingRef(plan)],
    ["Target", plan.prepared.target],
    ["Carry source", plan.carrySource?.path ?? "none"],
    ["Project config", trustLabel(plan)],
    [
      "Automation",
      `${plan.project?.config.hooks.pre_create.length ?? 0} pre-create, ${plan.project?.config.hooks.post_create.length ?? 0} post-create steps`,
    ],
    ["After creation", destinationLabel(destination)],
  ];
  writeLine(output.stdout, "");
  writeLine(output.stdout, style.heading(title));
  writeLine(
    output.stdout,
    renderTable(["SETTING", "VALUE"], rows, (cell, column) =>
      column === 0 ? style.label(cell) : style.value(cell),
    ),
  );
  if (plan.fetchedRemote) {
    writeLine(
      output.stdout,
      `${style.label("Preparation:")} Remote refs from ${style.value(plan.fetchedRemote)} were updated before this plan was shown.`,
    );
  }
}

function writeLine(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}

function strategyLabel(plan: CreatePlan): string {
  switch (plan.prepared.strategy.type) {
    case "local":
      return "check out an existing local branch";
    case "remote":
      return `track a branch from ${plan.prepared.strategy.remoteName}`;
    case "new":
      return "create a new local branch";
  }
}

function startingRef(plan: CreatePlan): string {
  switch (plan.prepared.strategy.type) {
    case "local":
      return plan.prepared.branchRef;
    case "remote":
      return `${plan.prepared.strategy.remoteName}/${plan.prepared.branch}`;
    case "new":
      return plan.prepared.strategy.base;
  }
}

function trustLabel(plan: CreatePlan): string {
  if (!plan.project?.requiresTrust) return "not required";
  return plan.trusted ? "trusted" : "approval required";
}

function destinationLabel(destination: CreateDestination): string {
  switch (destination.type) {
    case "stay":
      return "stay in the current directory";
    case "cd":
      return "enter the new worktree";
    case "open":
      return destination.tool
        ? `open with ${destination.tool}`
        : "open with the configured or selected tool";
  }
}
