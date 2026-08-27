# Agent workflows

Ygg gives every coding agent its own world: a concrete Git worktree rooted in the same repository.
Agents no longer share staged, unstaged, untracked, or generated files just because their tasks
belong to the same repository.

```mermaid
flowchart TB
    Git["Shared Git repository<br/>commits · branches · remotes"]
    Git --> Api["feature-api/<br/>API worktree"]
    Git --> Ui["feature-ui/<br/>UI worktree"]
    Api --> Codex["Codex process"]
    Ui --> App["Codex App process"]
```

Commits remain visible through the shared repository. Files, `HEAD`, the index, dependencies, and
agent processes stay with their worktree. Ports, databases, containers, and external services are
not automatically isolated; coordinate them separately.

The examples use the recommended flat [Ygg Flow layout](worktrees.md#ygg-flow), but the same agent
isolation works in grouped and retained-checkout workspaces.

## Run two tasks in parallel

**Starting point:** an API task and a UI task must progress independently.

```sh
ygg create feature/api
ygg create feature/ui
ygg list
```

```text
project/
├── feature-api/             Codex edits and commits feature/api here
└── feature-ui/              Codex App edits and commits feature/ui here
```

Built-in profiles cover Code, Cursor, Zed, Codex, Codex App, and Claude. Effective project
configuration can define additional profiles under `tools`; workspace-local definitions override
same-named repository profiles.

Open foreground agents from separate terminals:

```sh
# Terminal A
ygg open feature-api --tool codex

# Terminal B
ygg open feature-ui --tool codex-app
```

Each agent remains responsible for its own edits and commits. If the project exposes a `verify`
task, verify and remove the completed worktrees separately:

```sh
ygg run verify feature-api
ygg remove feature-api

ygg run verify feature-ui
ygg remove feature-ui
```

Removal preserves each branch. If another person or agent still needs a worktree, do not remove it
without an explicit handoff.

## Operating rules for agents

- Start with `ygg status --json` to understand the current context and local tracking state.
- Use `ygg list --json` for complete worktree records; do not guess paths from branch names.
- Resolve a path with `ygg cd <worktree>`.
- Prefer direct commands in non-interactive sessions.
- Run shared project actions through `ygg run` so configured order, environment, timeouts, and trust
  checks remain consistent.
- Use either `--tool` to open an agent or `--cd` to enter the worktree during creation; they cannot
  be combined.
- Inspect dirty, unmerged, and locked state before any forced removal.

Ygg deliberately does not orchestrate multiple agents, transfer patches, or infer handoffs. Those
operations require ownership and permission models outside the v1 workspace lifecycle.

See [Ygg Flow](worktrees.md#ygg-flow) for the recommended workspace layout,
[four everyday workflows](worktrees.md#four-everyday-workflows) for the general worktree model, and
[Configuration](configuration.md#named-tasks-and-tool-profiles) for custom tools and tasks.

## Portable Agent Skill

[`skills/ygg-worktrees`](../skills/ygg-worktrees/SKILL.md) teaches compatible agents how to discover
and use the CLI safely. Copy that directory into the skill location supported by the agent host, or
include it with the repository so the host can discover it.

The skill routes detailed creation and lifecycle questions to focused references, keeping its
default context small.
