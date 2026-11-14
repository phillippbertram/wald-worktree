---
title: "Troubleshooting"
description: "Find the workspace, inspect a failed setup, and repair missing worktree metadata."
---

## Check your context

```sh
wald doctor
wald status
wald list
```

Start with [doctor](cli-reference.md#wald-doctor) for runtime, Git, workspace, and configuration
checks. [Status](cli-reference.md#wald-status) shows the current checkout and local tracking
information. [List](cli-reference.md#wald-list) shows the exact paths.

If wald cannot find the workspace from your current directory, use
[`-C`](cli-reference.md#working-directory) to select an existing workspace directory. If
`wald cd` prints a path, load [shell integration](cli-reference.md#wald-completion) for your shell
or run the printed `cd` command.

## Resume a failed setup

Check the reported step and effective configuration before retrying. If the worktree was
created and its post-create setup failed, run `wald setup <worktree>` after correcting the issue.
If trust is required, [review the effective behavior](configuration.md#trust) before granting it.

## Repair a missing path

If a worktree directory was removed outside Git, `wald prune` previews stale registrations.
After reviewing the preview, `wald prune --apply` removes eligible stale metadata. Re-run
`wald init` to repair missing workspace infrastructure such as the worktree container or an
adopted workspace link. See [workspace layouts](worktrees.md#workspace-layouts).
