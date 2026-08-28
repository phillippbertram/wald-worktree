# Worktree operations

**Ygg Flow** means the recommended flat standalone layout: `.ygg`, `repo.git`, and all worktrees are
siblings in one workspace root. It does not define a branch or merge strategy. Other Ygg layouts use
the same commands and safety rules.

## Discover and select

Use `ygg status --json` for the current context and local tracking comparison. Use `ygg list --json`
for complete worktree records and `ygg cd <name-or-branch>` for the canonical path. `ygg cd` only
changes the parent shell when shell integration is installed.

## Create

```sh
ygg create <branch>
ygg create <new-branch> --from <commit-ish>
ygg create <new-branch> --carry
ygg handoff <new-branch>
```

Use `--cd` to enter the new worktree through shell integration, or `--tool <profile>` to open an
editor or agent. These destinations cannot be combined. When run inside a worktree, an explicit
`--from HEAD` uses that worktree's current commit; without `--from`, new branches use the configured
default branch. This start point defines history, not tracking: a new local branch has no upstream.
Do not publish it unless the user explicitly requests that external change; Ygg prints the matching
`git push -u <remote> HEAD` command for an authorized first push. Existing remote branches continue
to track their same-named remote ref.

Fetching follows the effective project-configuration default. Override it only when the task
requires it with `--fetch` or `--no-fetch`. Use `--tool <profile>` to open an editor or agent after
setup.

`--carry` and `handoff` use the current worktree's exact `HEAD` and require a new branch. They copy
staged, unstaged, and non-ignored untracked code, verify that the source stayed unchanged, and leave
the changes in both worktrees. Ignored files remain in the source. `handoff` is code-only and does
not move an editor, process, or agent session. If transfer fails before `post_create`, Ygg rolls back
the fresh target and branch when it can do so safely; a `post_create` failure keeps the transferred
target for `ygg setup` recovery.

Creation runs trusted `pre_create` before Git creates the checkout, followed by `post_create`. If
the latter phase fails, keep the created checkout, inspect the error, fix the
cause, and retry the printed `ygg setup <worktree>` command. To test hooks independently after a
configuration change, use `ygg hook run <event> <worktree>`; this runs no Git creation or removal.

Rename an eligible linked worktree directory without changing its branch, `HEAD`, index, or files:

```sh
ygg rename <worktree> <new-name>
```

Rename refuses the primary or current checkout, external, missing, locked, and submodule-containing
worktrees. It accepts dirty worktrees and runs no lifecycle hooks.

## Execute and remove

Pass command arguments after `--`:

```sh
ygg exec <worktree> -- pnpm test
```

Before removal, inspect `ygg list --json` and relevant Git state. Non-interactive removal requires
`--yes`. Add `--force` only with explicit permission to discard dirty, unmerged, or locked worktree
state:

```sh
ygg remove <worktree> --yes
```

This default removes only the checkout and preserves its branch. In a terminal, Ygg offers eligible
merged local branches for deletion with no preselection. In automation, use `--delete-branch --yes`
only when the user explicitly authorizes deleting the corresponding local branch. The configured
default branch, unmerged branches, detached checkouts, and remote branches are never deleted;
`--force` alone grants no branch-deletion permission.

`ygg prune` is different from removal: it previews stale Git registrations for worktree directories
that are already missing. To apply that metadata-only cleanup non-interactively, use:

```sh
ygg prune --apply --yes
```

Pruning never deletes a branch or directory and leaves locked registrations untouched.

After pruning manually deleted worktrees, re-run `ygg init` to restore a missing configured worktree
container or `.ygg` metadata link. To disconnect the repository from Ygg instead, preview:

```sh
ygg uninit
```

Apply non-interactively with `ygg uninit --apply --yes`. Registered linked worktrees always block the
operation. Local metadata and shared files require explicit permission to discard with `--force`.
