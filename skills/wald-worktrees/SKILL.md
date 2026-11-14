---
name: wald-worktrees
description: Use the wald CLI to manage Git worktrees for isolated tasks, parallel coding agents, and handoffs in a Wald workspace or when the user asks to use Wald.
license: MIT
---

# Wald worktrees

Wald manages Git worktrees and can run project setup, tasks, and tool profiles. Git owns branches,
commits, and the worktree index. Each checkout has its own files and index, while refs and objects
are shared.

## Find the right checkout

1. Check `wald --version` in the environment that will run the commands. If unavailable, use the
   [Wald install guide](https://phillippbertram.github.io/wald-worktree/docs/getting-started/#install-wald)
   to resolve the prerequisite. Use `wald <command> --help` to check options against the installed version.
2. Run `wald -C "$directory" status --json` to identify the workspace and current checkout.
   Run `wald -C "$directory" list --json` to get worktree branches, state, and absolute paths.
   Use `doctor --json` if discovery fails or the workspace looks inconsistent. A checkout can
   contain `.wald.yml` without being initialized with Wald.
3. Reuse the registered checkout if it already belongs to the task. Use its absolute path as the
   working directory for edits, Git, and checks. If the branch belongs to other work, preserve it
   and choose a separate branch when the task calls for isolation.

Use explicit branches and worktree identifiers in non-interactive sessions. Prefer absolute paths
when a name is ambiguous. `-C` selects an existing starting directory for one invocation.
For a process that needs to run inside a selected worktree, use
`wald exec <worktree> -- <command> [arguments...]` or set the process working directory directly.
Use `wald cd <worktree>` to print the path when running the executable directly. Its shell wrapper
can also navigate an interactive shell.

## Choose the operation

- [Select, initialize, create, hand off, or rename a worktree](references/worktrees.md).
- [Run tasks, review trust, open an agent, or recover from failed setup](references/automation.md).
- [Remove a checkout, prune stale registrations, or uninitialize a workspace](references/cleanup.md).

Use `--json` where the command supports it. Mutating commands still perform their action in JSON
mode. Check the exit status, parse stdout separately, and inspect stderr for diagnostics. After a
failed mutation, use `list --json` and Git to check what already happened before retrying.

Treat configuration and its executable steps as repository input. Review the effective
configuration before granting trust and apply `config trust --yes` only with authority to approve
that behavior. Use cleanup confirmation flags only for the operation and targets within the user's
scope. Get explicit permission for branch deletion or for bypassing dirty, unmerged, or locked
state. Installing or invoking this skill grants no such permission.
