---
title: "Parallel coding agents"
description: "Give each agent its own Git worktree and run checks in the right checkout."
---

Give the API task and the UI task different working directories. Both agents can edit and stage
files at the same time, and both can see commits in the shared repository.

The examples use [Wald Flow](worktrees.md#wald-flow). The same commands also work in grouped and
retained-checkout workspaces. Assign each task a branch and coordinate any ports, databases,
containers, and other external resources they need.

## Run two tasks in parallel

Suppose one agent owns an API change and another owns a UI change. Start with a worktree for each
branch:

```sh
wald create feature/api
wald create feature/ui
wald list
```

```text
project/
├── feature-api/             Codex edits and commits feature/api here
└── feature-ui/              Codex App edits and commits feature/ui here
```

Open the agents from separate terminals:

```sh
wald open feature-api --tool codex
wald open feature-ui --tool codex-app
```

When both agents finish, run any configured checks and preview cleanup:

```sh
wald run verify feature-api
wald run verify feature-ui
wald remove feature-api feature-ui --dry-run --json
```

Check the branch actions, blockers, force reasons, and trust requirements. Once authorized,
repeat the command with `--yes` in place of `--dry-run`. Branches are kept by default.
If branch deletion is intended, include `--delete-branch` in both the preview and execution.
Use `--force` only with permission to discard the reported work or bypass a lock.
See [removal and partial failures](cli-reference.md#wald-remove).

## Hand off unfinished code

If unfinished local code should continue on a fresh branch, run the handoff from the folder that
contains those changes:

```sh
wald handoff feature/review --tool codex
```

Pass the task context to the new agent session. See
[Hand off and finish work](finish.md#continue-unfinished-code-in-a-new-worktree) for which local
changes carry over.

## Operating rules for agents

- Select the working directory with `wald -C <directory>`. Use `--no-input` for unattended text
  commands, including agents running in a terminal.
- Read `wald status --json` for the current checkout and tracking state, or `wald list --json`
  for all worktree paths. Use `wald doctor --json` to diagnose inconsistent state.
- Supply explicit targets and any required confirmations. `--json` sets the output format and
  disables prompts. Mutating commands still apply their changes.
- Discover configured tasks with `wald run --list <worktree> --json`, then run a trusted task
  with `wald run <task> <worktree>`.

See [working directory](cli-reference.md#working-directory) for relative paths and
[configuration](configuration.md#named-tasks-and-tool-profiles) for custom tools and tasks.

## Install the Wald agent skill

[`wald-worktrees`](../skills/wald-worktrees/SKILL.md) teaches agents how to find the right checkout,
create or hand off a worktree, run trusted project tasks, and recover safely from failures.
[Install the wald CLI](getting-started.md#install-wald) so `wald --version` works in the environment
where the agent runs. The skill contains instructions and reference files.

From the project where you want to use it, run the [Skills CLI](https://www.skills.sh/docs/cli) and
choose your agent:

```sh
pnpm dlx skills add phillippbertram/wald-worktree --skill wald-worktrees
```

Add `--global` to install for your user across projects. For Codex, you can select the target
explicitly with `--agent codex`.

For a manual installation, copy the whole `skills/wald-worktrees/` directory, including
`references/`, into the skill directory for your agent. For Codex, use `.agents/skills/` in the
project or `~/.agents/skills/` for your user.

Start a new agent session in the target project. In Codex, try
“Use `$wald-worktrees` to find the checkout for `feature/search` and run its verification task.”
The agent can also pick up the skill when you ask it to work in a Wald workspace.
