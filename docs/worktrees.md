---
title: "Why worktrees?"
description: "Keep unfinished work open while you switch tasks or start a coding agent."
---

You're halfway through a search feature when a production fix comes in. With one checkout, you
need to put away the unfinished changes before switching branches. With a second worktree, you
can leave the feature open and start the fix in a separate folder.

## The forest as a mental model

Picture separate trees with connected roots. The roots are one Git repository: commits,
branches, tags, and remotes. Each tree is a worktree, a working directory with its own
checked-out files and staging area.

## The four building blocks

A branch names a line of commits. A checkout is the set of files Git writes into a directory. A
worktree combines those files with its own HEAD and index. An ordinary clone starts with one
worktree, and Git can attach more to the same repository.

## Shared and independent state

| Shared repository | Each worktree |
| --- | --- |
| Commits, branches, tags, remotes, and stashes | Files, HEAD, index, and generated output |
| A fetch updates remote-tracking refs for every checkout | Editing or staging a file affects its own checkout |
| Commits become visible from other worktrees | Editors and agents can keep working in their assigned folders |

Separate folders give agents separate local files and staging areas. Ports, databases,
containers, and other services still need coordination. Git generally allows each branch to be
checked out in only one worktree at a time.

## Four everyday workflows

### 1. Fix production without disturbing a feature

You are halfway through `feature/payment` when production needs a fix based on `release/1.x`. Leave
the feature folder alone and create the hotfix beside it:

```sh
wald create hotfix/payment --from release/1.x --tool code
```

```text
project/
├── feature-payment/         unfinished files remain exactly as they are
└── hotfix-payment/          clean checkout based on release/1.x
```

Commit and publish the hotfix normally. After it is merged:

```sh
wald remove hotfix-payment
```

The hotfix folder is removed after safety checks. The branch and the feature worktree remain.

### 2. Review a teammate's branch beside your own work

Your current branch needs to stay open, but `contributor/payment-fix` is ready for review on the
configured remote. Create a second folder and run the project's `verify` task there:

```sh
wald create contributor/payment-fix --tool code
wald run verify contributor-payment-fix
```

```text
project/
├── feature-payment/             your current work
└── contributor-payment-fix/     review checkout tracking the remote branch
```

When the review is complete:

```sh
wald remove contributor-payment-fix
```

Wald fetches according to project configuration and prefers an existing local branch, then a matching
remote branch, before creating a new branch. A matching remote branch is tracked. A newly created
local branch has no upstream even when its history starts at the configured remote default branch;
Wald prints the explicit `git push -u <remote> HEAD` command needed to publish it.

### 3. Keep coding while a long test runs

A migration test will run for a while, and you still want to use the main folder for development.
Give the test its own worktree:

```sh
wald create experiment/migration
wald exec experiment-migration -- pnpm test
```

```text
project/
├── main/                    editor and development server stay available
└── experiment-migration/    test process and generated output stay here
```

Continue in `main/` from another terminal. Inspect and remove the experiment when it is no longer
needed:

```sh
wald remove experiment-migration
```

### 4. Give parallel agents separate files

Create one worktree for the API and one for the UI. Each agent can edit, stage, and run tests in
its own folder. Follow [Parallel coding agents](agent-workflows.md) to create and open both.

## Carry unfinished code into another worktree

Sometimes the code in front of you belongs on a fresh branch, but cleaning the current folder first
would only get in the way. Carry the staged, unstaged, and untracked state into a new worktree:

```sh
wald create feature/review --carry
# equivalent code-focused workflow
wald handoff feature/review
```

```text
project/
├── feature-payment/         original local state remains here
└── feature-review/          same local state, new branch at the original HEAD
```

Carry preserves which tracked changes are staged and which remain unstaged. It also copies
non-ignored untracked regular files and symlinks, including binary content and executable modes.
Ignored files remain local and can instead be supplied through trusted copy or symlink
configuration. Empty directories and submodules are not transferred.

Both commands use the current effective project configuration and the normal trusted lifecycle. A
transfer failure before `post_create` rolls back the fresh worktree and branch when safe; a
`post_create` failure keeps the verified target for `wald setup`. After success, the changes exist in
both worktrees. `handoff` does not move an editor, process, or agent session.

When the branch was chosen interactively, Wald shows the complete plan before trust, hooks, branch
creation, or checkout creation. **Change options…** lets you adjust the directory, setup, and opening
behavior before choosing **Create worktree**. `--skip-hooks`, or skipping hooks in the review,
bypasses all create-hook steps, including copies and symlinks.
See the [create reference](cli-reference.md#wald-create) for trust behavior and back navigation.
Explicit branch commands do not add this review.

## The worktree lifecycle

Creation and removal follow the same path in every supported workspace layout. **Wald Flow** is the
name of the recommended flat layout, not a branching model or this create-to-remove sequence.
Creation resolves the branch and project configuration, checks trust for enabled automation,
and runs the configured setup around the Git checkout. When carrying code, Wald verifies the
copy before running post-create setup. If setup fails, retry in the retained target with
`wald setup`.

Finish with `wald remove` after checking the worktree state. Use `wald prune` to preview stale
Git registrations for directories that are already missing. See [Finish a worktree](finish.md)
for a worked example.

## Workspace layouts

### Wald Flow

**Wald Flow** is Wald's recommended flat standalone layout. The shared repository and every worktree
are siblings directly inside one workspace root:

```text
project/
├── .wald/
│   ├── workspace.yml
│   └── shared/
├── repo.git/
├── main/
└── feature-payment/
```

Create it directly from a remote repository:

```sh
wald init git@github.com:example/project.git ~/dev/project
```

Despite the name, Wald Flow is not another branching model such as git-flow or GitHub Flow. It only
describes where the repository and worktree folders live. Branch names, merge direction, releases,
and deployments stay up to the project.

### Grouped standalone workspace

Use a dedicated container when the workspace root should not contain checkout folders directly:

```text
project/
├── .wald/
├── repo.git/
└── worktrees/
    ├── main/
    └── feature-payment/
```

```sh
wald init git@github.com:example/project.git ~/dev/project --worktrees-dir worktrees
```

### Retained existing checkout

If the repository already exists on disk, guided initialization can leave that checkout in place and
put new worktrees in a separate directory:

```text
~/dev/
├── project/                         protected existing checkout
│   └── .git/wald/
│       ├── workspace.yml
│       └── shared/
└── project-worktrees/
    ├── .wald -> ../project/.git/wald
    └── feature-payment/
```

```sh
cd ~/dev/project
wald init
```

Wald suggests a safe target, shows the absolute paths and resulting directory tree, then asks for
confirmation. The original checkout is never moved or deleted and is protected from `wald remove`.

Creating a separate standalone workspace from a local repository is different: Wald copies committed
branch history into independent Git object storage without hardlinks. Uncommitted or ignored files,
stashes, and detached commits without a branch stay in the source repository.

See [Configuration](configuration.md#supported-layouts) for generated paths and layout constraints.

## Wald and native Git

Wald uses Git for the underlying repository operations and adds the workspace rules around them:

| Intent | Wald workflow | Native foundation |
| --- | --- | --- |
| Create a checkout | `wald create <branch>` | `git worktree add` |
| Carry current code to a fresh checkout | `wald create <branch> --carry`, `wald handoff <branch>` | Binary Git patches plus verified untracked-file copy |
| Understand the current context | `wald status` | Local Git status, tracking refs, and Wald configuration |
| Find all checkouts | `wald list` | `git worktree list` plus Wald state |
| Enter a checkout | `wald cd <worktree>` | Resolve and print its canonical path |
| Rename a checkout and branch | `wald rename <worktree> <new-name>` | Verified local `git branch --move` and `git worktree move` |
| Run hooks, setup, or tasks | `wald hook run`, `wald setup`, `wald run` | Trusted effective project behavior |
| Finish with a checkout | `wald remove <worktree>` | Safety inspection and `git worktree remove` |
| Clean stale metadata | `wald prune` | Preview-first `git worktree prune` |
| Repair workspace infrastructure | `wald init` | Restore the configured container, metadata link, or shared directory |
| Stop managing the repository with Wald | `wald uninit` | Preview-first removal of Wald-owned metadata |

Use Wald when creating, finding, preparing, or removing worktrees so those workspace rules are
applied. Inside a worktree, regular Git commands continue to work normally.

## Common questions and pitfalls

### Can the same branch be checked out twice?

Git normally prevents one branch from being checked out in multiple worktrees. Create a separate
branch if two folders need to evolve independently.

### Are worktrees lightweight clones?

They share Git object storage, but every worktree still contains its own checked-out files,
dependencies, and build output. Large repositories and monorepos can therefore use significant disk
space even though Git history is not duplicated.

### Are running applications isolated?

Only their folders and processes are separate. Fixed ports, container names, volumes, databases,
device targets, and cloud resources can still collide. Coordinate those resources or run only one
conflicting environment at a time.

### Can I move or delete a worktree folder manually?

Do not move or delete it manually. Git keeps administrative links between the shared repository and
each worktree. Use `wald rename` for an eligible linked worktree and `wald remove` for normal
cleanup. Rename uses the new directory name as the new local branch name. Use
`--branch feature/payment-review` for a different branch name, or `--keep-branch` to move only the
directory; these options cannot be combined. The default branch and detached worktrees require
`--keep-branch`. Dirty files, the index, `HEAD`, file modes, and upstream tracking stay unchanged.
Rename never changes remotes and attempts an identity-checked rollback after a failure. See the
[rename reference](cli-reference.md#wald-rename) for all safety checks and recovery behavior.

If a directory is already missing, preview its stale registration with `wald prune`; that
repairs Git metadata without touching surviving worktrees or branches.

### Does removing a worktree delete its branch?

Not by default. `wald remove` removes the linked checkout after safety checks and keeps its branch.
In a terminal, Wald previews the target and offers **Cancel**, removal while keeping branches, or
removal with eligible local branch deletion. Cancel is selected by default. Multiple worktrees allow
choosing branches before a final confirmation; no branch is preselected. An unmerged branch is
offered only with `--force` and is clearly labeled.
Scripts can request the same behavior explicitly with `--delete-branch --yes`, adding `--force`
when the branch is unmerged. The configured default branch, detached checkouts, and remote branches
are never deleted. `wald prune` removes only stale administrative metadata and never deletes an
existing directory or branch.

### How do I remove Wald from an existing repository?

Remove linked worktrees normally, prune registrations for folders that are already missing, then run
`wald uninit`. The command previews its changes. `wald uninit --apply` removes the workspace
configuration and metadata link but keeps the Git repository, branches, primary checkout, worktree
container, and `.wald.yml`. Local files below the Wald metadata directory require `--force`.
This includes workspace-local `.wald/project.yml`; preview its removal before granting `--force`.

### Do I need a worktree for every branch?

No. Use them when simultaneous folders preserve meaningful context: a hotfix, review, long-running
job, or parallel agent. For a quick isolated change, normal branch switching may be simpler.

## Further reading

- [Official Git worktree documentation](https://git-scm.com/docs/git-worktree)
- [DataCamp: Git Worktree Tutorial](https://www.datacamp.com/tutorial/git-worktree-tutorial)
- [Wald brand identity](brand.md)
- [Wald CLI reference](cli-reference.md)
- [Wald configuration](configuration.md)
