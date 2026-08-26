# Worktree operations

## Discover and select

Use `wt list --json` for machine-readable state and `wt cd <name-or-branch>` for the canonical
path. `wt cd` only changes the parent shell when shell integration is installed.

## Create

```sh
wt create <branch>
wt create <new-branch> --from <commit-ish>
```

Use `--cd` to enter the new worktree through shell integration, or `--tool <profile>` to open an
editor or agent. These destinations cannot be combined. When run inside a worktree, an explicit
`--from HEAD` uses that worktree's current commit; without `--from`, new branches use the configured
default branch.

Fetching follows the `.wt.yml` default. Override it only when the task requires it with
`--fetch` or `--no-fetch`. Use `--tool <profile>` to open an editor or agent after setup.

Creation runs trusted `pre_create` before Git creates the checkout, followed by `post_create`. If
the latter phase fails, keep the created checkout, inspect the error, fix the
cause, and retry the printed `wt setup <worktree>` command.

## Execute and remove

Pass command arguments after `--`:

```sh
wt exec <worktree> -- pnpm test
```

Before removal, inspect `wt list --json` and relevant Git state. Non-interactive removal requires
`--yes`. Add `--force` only with explicit permission to discard dirty, unmerged, or locked worktree
state:

```sh
wt remove <worktree> --yes
```
