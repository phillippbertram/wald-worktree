---
name: ygg-worktrees
description: Use the ygg CLI to create, inspect, enter, automate, open, safely remove, and prune Git worktrees. Apply when a repository is managed by ygg or the user asks for a ygg-based worktree or agent workflow.
---

# ygg worktrees

Use `ygg` as the workspace interface and Git as the underlying source of truth.

Start with read-only discovery:

```sh
ygg status --json
ygg list --json
ygg config
ygg prune
```

Use `status` for the current context and local tracking comparison, then `list` for complete
worktree records and paths. Resolve locations with `ygg cd`; do not derive directory names from
branches. Prefer direct commands in non-interactive agent sessions and include required
confirmation flags explicitly.

- For creating or selecting a worktree, read [references/worktrees.md](references/worktrees.md).
- For hooks, tasks, trust, or failures during setup, read
  [references/automation.md](references/automation.md).
- For starting an editor or coding agent, use `ygg open <worktree> --tool <profile>`. Inspect
  built-in profiles with `ygg open --help` and effective project profiles with `ygg config` when
  needed.

Do not use `--force` for removal without verifying that dirty or unmerged work can be discarded.
Never infer permission to delete branches or the primary checkout; `ygg` does not perform those
actions as part of normal removal.

Use `ygg prune` as a read-only preview of stale Git metadata. Apply it non-interactively only with
`ygg prune --apply --yes`; this does not remove directories or branches and preserves locked entries.
If the configured worktree container or `.ygg` link is missing, re-run `ygg init` after pruning to
repair it. To stop managing a repository with Ygg, preview `ygg uninit`; apply non-interactively only
with `ygg uninit --apply --yes`. Never add `--force` without permission to discard local metadata and
shared files.

If effective project configuration is untrusted, inspect both reported sources plus the hooks,
tasks, and tools before running `ygg config trust --yes`. Formatting-only edits preserve semantic
trust, but changed behavior in either source requires a new decision. Use
`ygg hook run <event> <worktree>` to test a hook without creating or removing a worktree. Treat
`UNCHANGED` and configured `SKIPPED` file rows as successful no-ops; inspect `FAILED` target
conflicts before choosing `on_existing: skip` or `on_existing: replace` in the trusted configuration.
