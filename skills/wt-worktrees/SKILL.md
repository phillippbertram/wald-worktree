---
name: wt-worktrees
description: Use the wt CLI to create, inspect, enter, automate, open, and safely remove Git worktrees. Apply when a repository is managed by wt or the user asks for a wt-based worktree or agent workflow.
---

# wt worktrees

Use `wt` as the workspace interface and Git as the underlying source of truth.

Start with read-only discovery:

```sh
wt list --json
wt config
```

Resolve locations with `wt cd`; do not derive directory names from branches. Prefer direct
commands in non-interactive agent sessions and include required confirmation flags explicitly.

- For creating or selecting a worktree, read [references/worktrees.md](references/worktrees.md).
- For hooks, tasks, trust, or failures during setup, read
  [references/automation.md](references/automation.md).
- For starting an editor or coding agent, use `wt open <worktree> --tool <profile>`. Inspect
  available profiles with `wt completion tools` when needed.

Do not use `--force` for removal without verifying that dirty or unmerged work can be discarded.
Never infer permission to delete branches or the primary checkout; `wt` does not perform those
actions as part of normal removal.

If `.wt.yaml` is untrusted, inspect the reported hooks, tasks, and tools before running
`wt config trust --yes`. A formatting-only edit preserves its semantic trust, but changed behavior
requires a new decision.
