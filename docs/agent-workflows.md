# Agent workflows

`wt` treats an agent like any other tool attached to a concrete worktree. It creates the isolated
checkout, prepares it through trusted hooks, and starts the configured process there. The agent
itself remains responsible for its edits and commits.

## Start an agent

Built-in foreground profiles:

```sh
wt open feature/payment --tool codex
wt open feature/payment --tool claude
```

The `codex-app` profile opens the selected directory in the Codex desktop app. Project-specific
agents can be declared under `tools` in `.wt.yml`.

## Recommended sequence

```sh
wt create feature/payment --tool codex
wt run verify feature/payment
```

Choose one destination while creating: `--tool` opens the agent, while `--cd` enters the worktree
through shell integration. They are intentionally not combined.

Agents should use `wt list --json` and `wt cd <worktree>` for discovery instead of deriving paths.
They should run configured project actions through `wt run`, because those actions share the same
validation and trust boundary as lifecycle hooks.

`wt` deliberately does not orchestrate multiple agents, transfer patches, or infer handoffs. Those
operations require explicit ownership and permission models and remain outside v1.

## Portable Agent Skill

[`skills/wt-worktrees`](../skills/wt-worktrees/SKILL.md) teaches compatible agents how to discover
and use the CLI safely. Copy that directory into the skill location supported by the agent host, or
include it with the repository so the host can discover it.

The skill routes detailed creation/lifecycle questions to its focused references, keeping the
default context small.
