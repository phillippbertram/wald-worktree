---
title: "Hand off and finish work"
description: "Copy unfinished changes into a new checkout and safely remove worktrees when work is done."
---

## Continue unfinished code in a new worktree

Suppose a draft search change needs its own review branch. Run `handoff` in the worktree that
contains the changes, or select it with `-C`:

```sh
wald -C feature-search handoff feature/review
wald -C feature-review status
```

The example starts at a Wald Flow workspace root. In other layouts, use the source and target
paths from `wald list`.

The target starts at the source commit and gets the staged, unstaged, and non-ignored untracked
changes. The source keeps its changes. Open a new editor or agent session in the target and
pass along any task context. See [handoff](cli-reference.md#wald-handoff) for the full contract.

## Remove a checkout after review

```sh
wald list
wald remove review-ui
```

Inspect the proposed worktree and branch. Choose **Remove worktree, keep branches** to retire
the checkout while keeping its branch. In the terminal, the action menu starts on **Cancel**.

If wald reports local changes, an unmerged branch, or a lock, check whether the checkout still
has work to preserve. If a directory is already missing, use `wald prune` to preview stale
registrations. See [remove](cli-reference.md#wald-remove) and [prune](cli-reference.md#wald-prune)
for confirmation and automation details.
