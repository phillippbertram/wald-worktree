---
name: ygg-worktrees
description: Use the ygg CLI to create, inspect, enter, automate, open, safely remove, and prune Git worktrees. Apply when a repository is managed by ygg or the user asks for a ygg-based worktree or agent workflow.
---

# ygg worktrees

Use `ygg` as the workspace interface and Git as the underlying source of truth.

Start with read-only discovery:

```sh
ygg list --json
ygg config
ygg prune
```

Resolve locations with `ygg cd`; do not derive directory names from branches. Prefer direct
commands in non-interactive agent sessions and include required confirmation flags explicitly.

- For creating or selecting a worktree, read [references/worktrees.md](references/worktrees.md).
- For hooks, tasks, trust, or failures during setup, read
  [references/automation.md](references/automation.md).
- For starting an editor or coding agent, use `ygg open <worktree> --tool <profile>`. Inspect
  built-in profiles with `ygg open --help` and project profiles in `.ygg.yml` when needed.

Do not use `--force` for removal without verifying that dirty or unmerged work can be discarded.
Never infer permission to delete branches or the primary checkout; `ygg` does not perform those
actions as part of normal removal.

Use `ygg prune` as a read-only preview of stale Git metadata. Apply it non-interactively only with
`ygg prune --apply --yes`; this does not remove directories or branches and preserves locked entries.
If the configured worktree container or `.ygg` link is missing, re-run `ygg init` after pruning to
repair it. To stop managing a repository with Ygg, preview `ygg uninit`; apply non-interactively only
with `ygg uninit --apply --yes`. Never add `--force` without permission to discard local metadata and
shared files.

If `.ygg.yml` is untrusted, inspect the reported hooks, tasks, and tools before running
`ygg config trust --yes`. A formatting-only edit preserves its semantic trust, but changed behavior
requires a new decision.
