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

### 2. Review a teammate's branch

Create a checkout for the review and run the project's verification task there:

```sh
wald create contributor/payment-fix --tool code
wald run verify contributor-payment-fix
```

wald prefers an existing local branch, then a matching remote branch. See
[branch resolution](cli-reference.md#wald-create) for tracking and publishing details.

### 3. Keep coding while a long test runs

Run the test in its own worktree so the main checkout stays available:

```sh
wald create experiment/migration
wald exec experiment-migration -- pnpm test
```

### 4. Give parallel agents separate files

Follow [Parallel coding agents](agent-workflows.md) to give each agent its own files and index.

## Carry unfinished code into another worktree

Use [`wald handoff`](finish.md#continue-unfinished-code-in-a-new-worktree) to copy staged,
unstaged, and non-ignored untracked changes into a new worktree. The source keeps its changes.

## The worktree lifecycle

[Project setup](project-setup.md) explains how to configure and trust automation that runs when
worktrees are created or removed. If setup fails after creation, retry in the retained target with
`wald setup`. See [Hand off and finish work](finish.md) for removal and stale registrations.

## Workspace layouts

### Wald Flow

**Wald Flow** is wald's recommended flat standalone layout. The shared repository and every worktree
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

wald suggests a safe target, shows the absolute paths and resulting directory tree, then asks for
confirmation. The original checkout is never moved or deleted and is protected from `wald remove`.

Creating a separate standalone workspace from a local repository is different: wald copies committed
branch history into independent Git object storage without hardlinks. Uncommitted or ignored files,
stashes, and detached commits without a branch stay in the source repository.

See [Configuration](configuration.md#supported-layouts) for generated paths and layout constraints.

## wald and native Git

wald uses Git for the underlying repository operations and adds the workspace rules around them:

| Intent | wald workflow | Native foundation |
| --- | --- | --- |
| Create a checkout | `wald create <branch>` | `git worktree add` |
| Carry current code to a fresh checkout | `wald create <branch> --carry`, `wald handoff <branch>` | Binary Git patches plus verified untracked-file copy |
| Understand the current context | `wald status` | Local Git status, tracking refs, and wald configuration |
| Find all checkouts | `wald list` | `git worktree list` plus wald state |
| Enter a checkout | `wald cd <worktree>` | Resolve and print its canonical path |
| Rename a checkout and branch | `wald rename <worktree> <new-name>` | Verified local `git branch --move` and `git worktree move` |
| Run hooks, setup, or tasks | `wald hook run`, `wald setup`, `wald run` | Trusted effective project behavior |
| Finish with a checkout | `wald remove <worktree>` | Safety inspection and `git worktree remove` |
| Clean stale metadata | `wald prune` | Preview-first `git worktree prune` |
| Repair workspace infrastructure | `wald init` | Restore the configured container, metadata link, or shared directory |
| Stop managing the repository with wald | `wald uninit` | Preview-first removal of wald-owned metadata |

Use wald when creating, finding, preparing, or removing worktrees so those workspace rules are
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

Use [`wald rename`](cli-reference.md#wald-rename) or [`wald remove`](cli-reference.md#wald-remove)
so Git can maintain its worktree registrations. For a folder that is already missing, preview stale
registrations with [`wald prune`](cli-reference.md#wald-prune).

### Does removing a worktree delete its branch?

Branch deletion is opt-in. See [removal and branch deletion](cli-reference.md#wald-remove)
for eligibility and confirmation rules.

### How do I remove wald from an existing repository?

Retire any linked worktrees first, then preview metadata removal with
[`wald uninit`](cli-reference.md#wald-uninit).

### Do I need a worktree for every branch?

No. Use them when simultaneous folders preserve meaningful context: a hotfix, review, long-running
job, or parallel agent. For a quick isolated change, normal branch switching may be simpler.

## Further reading

- [Official Git worktree documentation](https://git-scm.com/docs/git-worktree)
- [DataCamp: Git Worktree Tutorial](https://www.datacamp.com/tutorial/git-worktree-tutorial)
- [wald CLI reference](cli-reference.md)
- [wald configuration](configuration.md)
