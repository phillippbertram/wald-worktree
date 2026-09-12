import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CreatePlan } from "../src/services/worktree-workflow-service.js";
import { printCreatePlan } from "../src/ui/create-plan.js";

describe("create plan presentation", () => {
  it("shows the resolved strategy, safety context, automation, and destination", () => {
    const output = new PassThrough();
    printCreatePlan(
      plan({ type: "new", base: "origin/main" }),
      { type: "open", tool: "codex" },
      { stdout: output },
    );

    const rendered = readOutput(output);
    expect(rendered).toContain("feature/review");
    expect(rendered).toContain("create a new local branch");
    expect(rendered).toContain("origin/main");
    expect(rendered).toContain("/workspace/feature-review");
    expect(rendered).toContain("/workspace/main");
    expect(rendered).toContain("approval required");
    expect(rendered).toContain("1 pre-create, 2 post-create steps");
    expect(rendered).toContain("open with codex");
    expect(rendered).toContain("Remote refs from origin were updated");
  });

  it("uses human strategy names for local and remote branches", () => {
    const labels = [plan({ type: "local" }), plan({ type: "remote", remoteName: "origin" })].map(
      (createPlan) => {
        const output = new PassThrough();
        printCreatePlan(createPlan, { type: "stay" }, { stdout: output });
        return readOutput(output);
      },
    );

    expect(labels[0]).toContain("check out an existing local branch");
    expect(labels[1]).toContain("track a branch from origin");
  });
});

function readOutput(output: PassThrough): string {
  let rendered = "";
  for (let chunk = output.read(); chunk !== null; chunk = output.read()) {
    rendered += chunk.toString();
  }
  return rendered;
}

function plan(strategy: CreatePlan["prepared"]["strategy"]): CreatePlan {
  return {
    workspace: {
      root: "/workspace",
      configPath: "/workspace/.wald/workspace.yml",
      sharedDir: "/workspace/.wald/shared",
      gitDir: "/workspace/repo.git",
      worktreeDir: "/workspace",
      primaryWorktree: null,
      config: {
        version: 1,
        mode: "managed",
        paths: { git: "../repo.git", worktrees: "..", primaryWorktree: null },
        remote: { name: "origin", fetchRefspec: "+refs/heads/*:refs/remotes/origin/*" },
        defaultBranch: "main",
        trustedProjectConfig: null,
      },
    },
    prepared: {
      branch: "feature/review",
      branchRef: "refs/heads/feature/review",
      target: "/workspace/feature-review",
      projectRevision: "origin/main",
      strategy,
    },
    project: {
      path: "origin/main:.wald.yml",
      hash: "a".repeat(64),
      requiresTrust: true,
      sources: { repository: "origin/main:.wald.yml", workspace: null },
      config: {
        version: 1,
        defaults: { fetch: true },
        hooks: {
          pre_create: [{ type: "command", argv: ["true"], env: {}, continueOnError: false }],
          post_create: [
            { type: "command", argv: ["true"], env: {}, continueOnError: false },
            { type: "command", argv: ["true"], env: {}, continueOnError: false },
          ],
          pre_remove: [],
          post_remove: [],
        },
        tasks: {},
        tools: {},
      },
    },
    trusted: false,
    carrySource: {
      name: "main",
      role: "linked",
      path: "/workspace/main",
      head: "abc",
      branch: "main",
      branchRef: "refs/heads/main",
      locked: false,
      lockReason: null,
      prunable: false,
      state: "clean",
    },
    fetchedRemote: "origin",
    current: null,
    defaultWorktree: null,
    primary: null,
  };
}
