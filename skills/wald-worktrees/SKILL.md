---
name: wald-worktrees
description: Use the wald CLI to create, carry, hand off, rename, inspect, enter, automate, open, safely remove, and prune Git worktrees. Apply when a repository is managed by wald or the user asks for a wald-based worktree or agent workflow.
---

# wald worktrees

Use `wald` as the workspace interface and Git as the underlying source of truth.

Start with read-only discovery:

```sh
wald status --json
wald list --json
wald config --json
wald doctor --json
wald prune
```

Use `status` for the current context and local tracking comparison, then `list` for complete
worktree records and paths. Resolve locations with `wald cd`; do not derive directory names from
branches. Prefer direct commands in non-interactive agent sessions and include required
confirmation flags explicitly.
Use `doctor` when discovery, configuration, runtime versions, paths, worktree registrations, trust,
file sources, or configured executables may be inconsistent. Treat its suggestions as proposals;
do not run repairs or trust commands without the authority required for that mutation.

- For creating or selecting a worktree, read [references/worktrees.md](references/worktrees.md).
- For hooks, tasks, trust, or failures during setup, read
  [references/automation.md](references/automation.md).
- For starting an editor or coding agent, use `wald open <worktree> --tool <profile>`. Inspect
  built-in profiles with `wald open --help` and effective project profiles with `wald config` when
  needed.

Use `wald create <new-branch> --carry` or `wald handoff <new-branch>` only from the source worktree.
Both copy its staged, unstaged, and non-ignored untracked code into a fresh worktree while preserving
the source; they do not move a running process or agent session. Use `wald rename <worktree>
<new-name>` to rename an eligible linked worktree directory without renaming its branch.
For machine-readable mutations, use `--json` with explicit arguments. It still performs the action,
never prompts, and never grants confirmation: removal additionally requires `--yes`. Do not combine
create or handoff JSON mode with `--cd`, `--open`, or `--tool`.

Do not use `--force` for removal without verifying that local changes, an unmerged branch, or a
worktree lock can be discarded or bypassed. Wald prints these bypassed safeguards before removal.
Never infer permission to delete branches or the primary checkout. Normal removal preserves every
branch. Use `--delete-branch` only when the user explicitly authorizes deletion of the eligible
local branch. Deleting an unmerged branch also requires explicit permission to discard it and
`--force`; Wald never deletes the configured default branch or its remote counterpart.

Use `wald prune` as a read-only preview of stale Git metadata. Apply it non-interactively only with
`wald prune --apply --yes`; this does not remove directories or branches and preserves locked entries.
If the configured worktree container or `.wald` link is missing, re-run `wald init` after pruning to
repair it. To stop managing a repository with Wald, preview `wald uninit`; apply non-interactively only
with `wald uninit --apply --yes`. Never add `--force` without permission to discard local metadata and
shared files.

If effective project configuration is untrusted, inspect both reported sources plus the hooks,
tasks, and tools before running `wald config trust --yes`. Formatting-only edits preserve semantic
trust, but changed behavior in either source requires a new decision. Use
`wald hook run <event> <worktree>` to test a hook without creating or removing a worktree. Treat
`UNCHANGED` and configured `SKIPPED` file rows as successful no-ops; inspect `FAILED` target
conflicts before choosing `on_existing: skip` or `on_existing: replace` in the trusted configuration.
