# Worktree cleanup

## Retire an existing checkout

Identify the exact path and branch with `list --json`. Check Git status in that checkout, review
any lock, and confirm the worktree is no longer in use. Wald checks whether the worktree's commit is
an ancestor of the configured default branch, preferring its local remote-tracking ref when
available. A squash merge can leave the original commit outside that history.

After verifying the checkout is in scope for removal, run the command from a directory that will
survive cleanup:

```sh
wald -C "$workspace" remove "$checkout" --yes --json
```

This removes the checkout and preserves its branch. Without `--yes`, the interactive command
offers a preview and confirmation. For automation, inspect the target before invoking the command.
A dirty worktree, unmerged branch, or lock needs explicit authority to bypass with `--force`.
Use `--delete-branch` only when the user explicitly requests deletion of the eligible local branch.
Wald protects the primary checkout and configured default branch and never deletes remote branches.

Configured removal hooks can run with trust. If removal reports a failure, read the error and its
JSON `effects` when present, then refresh `list --json` and check the branch. A `post_remove`
failure can leave the checkout already removed and the branch retained. For batched removals,
check each target before retrying.

## Repair stale registrations or stop managing the workspace

Preview the corresponding operation:

```sh
wald -C "$workspace" prune --json
wald -C "$workspace" uninit --json
```

- `prune` shows stale Git registrations for missing worktree directories. `prune --apply --yes`
  removes stale registrations and preserves locked entries, directories, and branches. If the
  configured worktree container or adopted checkout's `.wald` link is missing, `wald init`
  can repair that infrastructure.
- `uninit` previews removal of Wald workspace metadata. `uninit --apply --yes` requires all
  linked worktrees to be removed or their stale registrations pruned. Local metadata files and
  shared data block application unless explicitly authorized for discard with `--force`.
  Git data, branches, and the retained checkout are kept.

Apply only the previewed operation within the user's scope. Both previews can run without `--yes`.
