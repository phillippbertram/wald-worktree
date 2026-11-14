# Worktree operations

## Select or initialize a workspace

Discovery works from the workspace root, a retained primary checkout, or a linked worktree. In
Wald Flow, `.wald`, `repo.git`, and all worktrees are siblings. Other layouts can keep an existing
checkout or group worktrees under a separate directory. Read the actual paths from `list --json`.

If a checkout is unmanaged and the task calls for onboarding it to Wald, use
`wald -C "$checkout" init --adopt . --yes --json` to keep it in place. Add
`--worktrees-dir <path>` if a particular worktree container is needed. Use
`wald init <repository> <directory> --json` when the requested layout is a standalone clone.
Initialization writes workspace metadata. Confirm the intended source and destination before
running it. Use `--no-remote` with adoption when the repository is intentionally local-only.

## Create a checkout

```sh
wald -C "$workspace" create feature/search --json
wald -C "$workspace" create feature/review --from release/1.x --no-fetch --json
```

These are alternative examples. Choose a branch and base for the task. Wald resolves a name to an
existing local branch, then a matching remote-tracking branch, then a new branch. If the branch is
already checked out, locate it with `list --json` and decide whether to reuse it. If only the
directory name conflicts, use `--name <directory>` for a different directory.

- For a new branch, `--from <ref>` selects the base. `--from HEAD` from a concrete worktree uses
  that checkout's current commit. Without `--from`, Wald prefers the configured default branch's
  remote-tracking ref when available and otherwise uses the local default branch.
- Creation can fetch and update shared refs according to project settings. Use `--no-fetch` when
  the selected local refs must be used and `--fetch` when the task needs refreshed remote refs.
  `status --json` compares local refs without contacting the remote.
- A new branch has no upstream. A branch created from a matching remote-tracking branch tracks
  that branch. Publishing is a separate Git operation.
- Use `worktree.path` from the JSON result for subsequent work. JSON mode requires an explicit
  branch and conflicts with `--cd`, `--open`, and `--tool`. If opening a tool is part of the
  task, run `wald open` separately with the returned path.
- Creation normally runs trusted `pre_create` and `post_create` hooks. Read
  [automation and recovery](automation.md) before skipping or retrying setup.

For parallel tasks, use one checkout and branch per task. Pass each agent its checkout path and
task context. Coordinate shared resources such as ports and databases separately.

## Carry local edits

```sh
wald -C "$source_checkout" handoff feature/review --json
```

Use `handoff` or `create <new-branch> --carry` when the target needs the source's unfinished changes.
Select the actual source checkout with `-C`. Carry requires a fresh branch, starts at the source's
exact `HEAD`, and copies staged, unstaged, and non-ignored untracked state. The source keeps its
work. Ignored files, including ignored local settings, stay in the source. Pass task context to a
new agent session separately.

Carry rejects merge conflicts, active merge/rebase/cherry-pick state, sparse checkouts, and other
unsupported source state. Inspect the failure before retrying. If Wald preserves a partial target,
inspect its contents and branch first. If only `post_create` failed, recover the retained checkout
with `wald setup` after reviewing the failed steps.

## Rename an existing checkout

Run `wald rename <worktree> <new-name> --json` from the workspace root or another checkout.
By default this renames both the linked directory and its local branch. Use `--keep-branch` for
a directory-only move, which is required for the configured default branch or a detached checkout.
Use `--branch <new-branch>` to choose a different local branch name. Existing upstream tracking
is preserved. Use the returned `worktree.path` after success.

The primary and current checkouts are ineligible. Wald also checks for locks, unavailable or
external checkouts, submodules, and collisions. If rollback is incomplete, inspect the reported
paths and refs before any repair.
