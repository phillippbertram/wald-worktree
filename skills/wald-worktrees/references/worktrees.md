# Worktree operations

**Wald Flow** means the recommended flat standalone layout: `.wald`, `repo.git`, and all worktrees are
siblings in one workspace root. It does not define a branch or merge strategy. Other Wald layouts use
the same commands and safety rules.

## Discover and select

Use `wald status --json` for the current context and local tracking comparison. Use `wald list --json`
for complete worktree records and `wald cd <name-or-branch>` for the canonical path. `wald cd` only
changes the parent shell when shell integration is installed.
Use `wald doctor --json` for a read-only runtime, configuration, path, Git-registration, trust, file
source, and executable diagnosis. Review its suggestions before applying any repair.

## Create

```sh
wald create <branch>
wald create <new-branch> --from <commit-ish>
wald create <new-branch> --carry
wald create <branch> --skip-hooks
wald handoff <new-branch>
```

Use `--cd` to enter the new worktree through shell integration, or `--tool <profile>` to open an
editor or agent. These destinations cannot be combined. When run inside a worktree, an explicit
`--from HEAD` uses that worktree's current commit; without `--from`, new branches use the configured
default branch. This start point defines history, not tracking: a new local branch has no upstream.
Do not publish it unless the user explicitly requests that external change; Wald prints the matching
`git push -u <remote> HEAD` command for an authorized first push. Existing remote branches continue
to track their same-named remote ref.

An interactive branch or handoff choice offers whether to run configured create hooks, then a
create-plan confirmation before trust, hooks, or Git mutation. `Esc` returns to the preceding choice
and retains previous values; declining creation cancels the mutation. Explicit branch commands do
not add these questions. In automation, `create` and `handoff --json` require a branch and
cannot be combined with navigation or tool-opening options.

Fetching follows the effective project-configuration default. Override it only when the task
requires it with `--fetch` or `--no-fetch`. Use `--tool <profile>` to open an editor or agent after
setup.

`--carry` and `handoff` use the current worktree's exact `HEAD` and require a new branch. They copy
staged, unstaged, and non-ignored untracked code, verify that the source stayed unchanged, and leave
the changes in both worktrees. Ignored files remain in the source. `handoff` is code-only and does
not move an editor, process, or agent session. If transfer fails before `post_create`, Wald rolls back
the fresh target and branch when it can do so safely; a `post_create` failure keeps the transferred
target for `wald setup` recovery.

By default, creation runs trusted `pre_create` before Git creates the checkout, followed by
`post_create`. If the latter phase fails, keep the created checkout, inspect the error, fix the
cause, and retry the printed `wald setup <worktree>` command. To test hooks independently after a
configuration change, use `wald hook run <event> <worktree>`; this runs no Git creation or removal.

When the task calls for skipping setup, `create`, `plant`, and `handoff` accept `--skip-hooks`.
It skips both create events and all their command, copy, and symlink steps for that invocation.
Creation then needs no trust approval and does not alter saved trust; validation and carry checks
still apply. Tool opening retains its trust check. `wald setup <worktree>` can run `post_create`
later with the usual trust requirement.

Rename an eligible linked worktree directory and its local branch, preserving `HEAD`, index, files,
file modes, and upstream tracking:

```sh
wald rename <worktree> <new-name>
wald rename <worktree> <new-name> --branch feature/payment-review
wald rename <worktree> <new-name> --keep-branch
```

The default uses `new-name` for both directory and local branch. `--branch` supplies a different
branch name, including `/`; `--keep-branch` moves only the directory. These options are mutually
exclusive. Default-branch and detached worktrees require `--keep-branch`.

Rename refuses the primary or current checkout, external, missing, unavailable, locked, and
submodule-containing worktrees. It checks the destination, local branch collisions, literal Git ref
format, `HEAD`, branch identity, and upstream before mutation. Dirty worktrees are allowed. Rename
runs no lifecycle hooks and never creates, deletes, fetches, or pushes remote branches. Existing
tracking stays unchanged, so `payment-review` may continue to track `origin/feature/payment`.

On failure, Wald attempts an identity-checked rollback of both steps. If rollback is incomplete,
inspect the reported paths and refs and follow the recovery guidance; do not force or overwrite
concurrent work. `--json` adds `before.branch` and `branchChange: { before, after, renamed, upstream }`
to the result. Branch names and upstream are `null` when not applicable.

## Execute and remove

Pass command arguments after `--`:

```sh
wald exec <worktree> -- pnpm test
```

Before removal, inspect `wald list --json` and relevant Git state. Non-interactive removal requires
`--yes`. Add `--force` only with explicit permission to discard dirty, unmerged, or locked worktree
state:

```sh
wald remove <worktree> --yes
```

Add `--json` for one machine-readable result. It does not preview or confirm the removal, so both
the explicit worktree identifiers and `--yes` remain required.

This default removes only the checkout and preserves its branch. In a terminal, Wald offers eligible
local branches for deletion with no preselection. With `--force`, unmerged local branches are also
offered and clearly labeled. In automation, use `--delete-branch --yes` only when the user explicitly
authorizes deleting the corresponding local branch, and add `--force` only with permission to
discard unmerged work. The configured default branch, detached checkouts, and remote branches are
never deleted; `--force` alone grants no branch-deletion permission.

`wald prune` is different from removal: it previews stale Git registrations for worktree directories
that are already missing. To apply that metadata-only cleanup non-interactively, use:

```sh
wald prune --apply --yes
```

Pruning never deletes a branch or directory and leaves locked registrations untouched.

After pruning manually deleted worktrees, re-run `wald init` to restore a missing configured worktree
container or `.wald` metadata link. To disconnect the repository from Wald instead, preview:

```sh
wald uninit
```

Apply non-interactively with `wald uninit --apply --yes`. Registered linked worktrees always block the
operation. Local metadata and shared files require explicit permission to discard with `--force`.
