# Worktrees explained

Git worktrees let one repository provide several project folders at the same time. This guide builds
the mental model first, then shows where Ygg fits and how the workflow looks in daily development.

## Yggdrasil as a mental model

Ygg uses the world tree as a teaching aid for real Git concepts. The metaphor never replaces the
technical names used by Git, the CLI, or configuration:

| Yggdrasil image | Technical meaning |
| --- | --- |
| World tree | The complete Ygg workspace. |
| Roots | Git's common directory (`repo.git` in a standalone workspace), which keeps shared objects, refs, remotes, and worktree metadata. |
| Trunk | The configured default branch: the normal creation base and merge-check target. |
| Worlds | Independent worktree folders with their own files, `HEAD`, index, and processes. |
| Bifröst | `ygg cd` or `ygg open`, which takes you to a selected worktree without changing another. |

The default branch is the preferred base for new work and the comparison target for safe removal;
Ygg does not enforce one history. An explicit `--from` may start new work from another commit.

## The four building blocks

| Term | Think of it as | Example |
| --- | --- | --- |
| Repository | The shared Git database and history | Commits, branches, tags, and remotes |
| Branch | A movable name for a line of commits | `main`, `feature/payment` |
| Checkout | Files from one commit written into a folder | The files currently visible in an editor |
| Worktree | One checkout plus its own Git working state | `feature-payment/` with its own `HEAD` and index |

A normal clone combines one repository and one main worktree. Linked worktrees add more checkout
folders without cloning the complete repository again.

```mermaid
flowchart TB
    Repo["Roots · shared Git repository"]
    Repo --> History["Commits · branches · tags · remotes"]
    Repo --> Main["Main world · worktree<br/>HEAD: main · trunk"]
    Repo --> Feature["Feature world · linked worktree<br/>HEAD: feature/payment"]
    Repo --> Review["Review world · linked worktree<br/>HEAD: contributor/fix"]

    Main --> MainFiles["own files · index · dependencies"]
    Feature --> FeatureFiles["own files · index · dependencies"]
    Review --> ReviewFiles["own files · index · dependencies"]
```

In a Ygg standalone workspace, the same relationship is visible on disk:

```text
project/
├── .ygg/                    Ygg workspace metadata and shared local files
├── repo.git/                shared Git objects, refs, remotes, and worktree metadata
├── main/                    files + HEAD + index for main
├── feature-payment/         files + HEAD + index for feature/payment
└── contributor-fix/         files + HEAD + index for contributor/fix
```

Each worktree behaves like a normal repository folder: open it in an editor, run `git status`, edit
files, commit, and start processes there. A commit created in one worktree immediately becomes part
of the shared repository and is visible from the others.

## Shared and independent state

```mermaid
flowchart TB
    Shared["Shared repository state"]
    Shared --> Objects["commits and Git objects"]
    Shared --> Refs["branches, tags, remotes, stashes"]

    Local["Per-worktree state"]
    Local --> GitState["HEAD and index"]
    Local --> Files["checked-out and untracked files"]
    Local --> Runtime["dependencies, build output, editors, processes"]
```

| Action | Effect |
| --- | --- |
| Edit a file | Changes only that worktree's folder. |
| Stage a file | Changes only that worktree's index. |
| Create a commit | Adds the commit to the shared repository. |
| Fetch a remote | Updates shared remote-tracking refs for all worktrees. |
| Install dependencies | Writes into that worktree unless the package manager uses an external cache. |
| Start a server | Starts a separate process, but ports and external services may still conflict. |

## Four everyday workflows

### 1. Fix production without disturbing a feature

**Starting point:** `feature/payment` has uncommitted changes and production needs a fix based on
`release/1.x`.

```sh
ygg create hotfix/payment --from release/1.x --tool code
```

```text
project/
├── feature-payment/         unfinished files remain exactly as they are
└── hotfix-payment/          clean checkout based on release/1.x
```

Commit and publish the hotfix normally. After it is merged:

```sh
ygg remove hotfix-payment
```

The hotfix folder is removed after safety checks. The branch and the feature worktree remain.

### 2. Review a teammate's branch beside your own work

**Starting point:** the configured remote contains `contributor/payment-fix`, the project exposes a
`verify` task, and your current branch must stay open.

```sh
ygg create contributor/payment-fix --tool code
ygg run verify contributor-payment-fix
```

```text
project/
├── feature-payment/             your current work
└── contributor-payment-fix/     review checkout tracking the remote branch
```

When the review is complete:

```sh
ygg remove contributor-payment-fix
```

Ygg fetches according to project configuration and prefers an existing local branch, then a matching
remote branch, before creating a new branch. A matching remote branch is tracked. A newly created
local branch has no upstream even when its history starts at the configured remote default branch;
Ygg prints the explicit `git push -u <remote> HEAD` command needed to publish it.

### 3. Keep coding while a long test runs

**Starting point:** an experiment or verification job should not occupy the folder used for current
development.

```sh
ygg create experiment/migration
ygg exec experiment-migration -- pnpm test
```

```text
project/
├── main/                    editor and development server stay available
└── experiment-migration/    test process and generated output stay here
```

Continue in `main/` from another terminal. Inspect and remove the experiment when it is no longer
needed:

```sh
ygg remove experiment-migration
```

### 4. Give parallel agents separate files

**Starting point:** two coding tasks must not share staged, unstaged, untracked, or generated files.

```sh
ygg create feature/api
ygg create feature/ui
ygg list
```

```text
project/
├── feature-api/             API agent, commits on feature/api
└── feature-ui/              UI agent, commits on feature/ui
```

Open the agents from separate terminals so foreground tools can run at the same time:

```sh
# Terminal A
ygg open feature-api --tool codex

# Terminal B
ygg open feature-ui --tool codex-app
```

Each agent owns a real checkout. When the project exposes a `verify` task, verify and remove each
task independently:

```sh
ygg run verify feature-api
ygg remove feature-api
ygg run verify feature-ui
ygg remove feature-ui
```

Ygg separates filesystem state; it does not coordinate agent decisions, running sessions, ports,
databases, or other shared services.

## Carry unfinished code into another worktree

**Starting point:** the current branch has staged, unstaged, or untracked code that should continue
on a fresh branch without cleaning or changing the source.

```sh
ygg create feature/review --carry
# equivalent code-focused workflow
ygg handoff feature/review
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
`post_create` failure keeps the verified target for `ygg setup`. After success, the changes exist in
both worktrees. `handoff` does not move an editor, process, or agent session.

When the branch was chosen interactively, Ygg shows the complete create plan and confirms it before
trust, hooks, branch creation, or checkout creation. Explicit branch commands remain prompt-free.

## The worktree lifecycle

This lifecycle works in every supported workspace layout. **Ygg Flow** names the recommended flat
layout, not a branching model or this create-to-remove sequence.

```mermaid
flowchart TB
    Request["ygg create or handoff"] --> Resolve["Resolve branch and trusted configuration"]
    Resolve --> Pre["Run pre_create"]
    Pre --> Add["Create the Git worktree"]
    Add --> Carry["Optional carry<br/>apply and verify local code"]
    Carry --> Post["Run post_create setup"]
    Carry -- transfer fails --> Rollback["Roll back fresh checkout and branch"]
    Post --> Ready["Edit · commit · run · review"]
    Post -- setup fails --> Retry["Keep checkout<br/>retry with ygg setup"]
    Retry --> Ready
    Ready --> Inspect["ygg remove safety checks"]
    Ready -. optional .-> Verify["ygg run verify"]
    Verify --> Inspect
    Inspect --> Remove["Remove linked checkout<br/>keep branch"]

    Missing["Folder was already deleted outside Git"] --> Preview["ygg prune<br/>preview stale metadata"]
    Preview --> Apply["ygg prune --apply<br/>remove metadata only"]

    Apply --> Repair["ygg init<br/>repair missing workspace container or link"]
    Apply --> Uninit["ygg uninit<br/>preview removal of Ygg metadata"]
```

`remove` is the normal finish path. `prune` is not a faster removal command; it repairs stale Git
administrative state after a registered directory is already missing. Locked registrations are
preserved. `init` repairs the workspace infrastructure after stale registrations are gone;
`uninit` is the explicit path for disconnecting the repository from Ygg. A normal removal retires
one worktree world while its branch and the shared roots survive—no repository Ragnarök.

## Workspace layouts

### Ygg Flow

**Ygg Flow** is Ygg's recommended flat standalone layout. The shared repository and every worktree
are siblings directly inside one workspace root:

```text
project/
├── .ygg/
│   ├── workspace.yml
│   └── shared/
├── repo.git/
├── main/
└── feature-payment/
```

Create it directly from a remote repository:

```sh
ygg init git@github.com:example/project.git ~/dev/project
```

Like git-flow and GitHub Flow, the name describes a preferred way of working. Unlike those branching
models, Ygg Flow defines only the physical worktree layout. It does not prescribe branch names,
merge direction, release branches, or deployment policy.

### Grouped standalone workspace

Use a dedicated container when the workspace root should not contain checkout folders directly:

```text
project/
├── .ygg/
├── repo.git/
└── worktrees/
    ├── main/
    └── feature-payment/
```

```sh
ygg init git@github.com:example/project.git ~/dev/project --worktrees-dir worktrees
```

### Retained existing checkout

Guided initialization can keep an existing checkout in place and add a separate worktree container:

```text
~/dev/
├── project/                         protected existing checkout
│   └── .git/ygg/
│       ├── workspace.yml
│       └── shared/
└── project-worktrees/
    ├── .ygg -> ../project/.git/ygg
    └── feature-payment/
```

```sh
cd ~/dev/project
ygg init
```

The wizard suggests a safe target, previews absolute paths and the resulting tree, then asks for
confirmation. The original checkout is never moved or deleted and is protected from `ygg remove`.

Creating a separate standalone workspace from a local repository is different: Ygg copies committed
branch history into independent Git object storage without hardlinks. Uncommitted or ignored files,
stashes, and detached commits without a branch stay in the source repository.

See [Configuration](configuration.md#supported-layouts) for generated paths and layout constraints.

## Ygg and native Git

Ygg does not replace Git. It applies workspace policy around the native operations:

| Intent | Ygg workflow | Native foundation |
| --- | --- | --- |
| Create a checkout | `ygg create <branch>` | `git worktree add` |
| Carry current code to a fresh checkout | `ygg create <branch> --carry`, `ygg handoff <branch>` | Binary Git patches plus verified untracked-file copy |
| Understand the current context | `ygg status` | Local Git status, tracking refs, and Ygg configuration |
| Find all checkouts | `ygg list` | `git worktree list` plus Ygg state |
| Enter a checkout | `ygg cd <worktree>` | Resolve and print its canonical path |
| Rename a checkout directory | `ygg rename <worktree> <new-name>` | Validated `git worktree move` |
| Run hooks, setup, or tasks | `ygg hook run`, `ygg setup`, `ygg run` | Trusted effective project behavior |
| Finish with a checkout | `ygg remove <worktree>` | Safety inspection and `git worktree remove` |
| Clean stale metadata | `ygg prune` | Preview-first `git worktree prune` |
| Repair workspace infrastructure | `ygg init` | Restore the configured container, metadata link, or shared directory |
| Stop managing the repository with Ygg | `ygg uninit` | Preview-first removal of Ygg-owned metadata |

Use Ygg for normal workspace operations so paths, setup, trust, and safety checks stay consistent.
Regular Git commands inside a selected worktree continue to work normally.

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
each worktree. Use `ygg rename` for an eligible linked worktree directory and `ygg remove` for normal
cleanup. If a directory is already missing, preview its stale registration with `ygg prune`; that
repairs the roots without touching surviving worlds or branches.

### Does removing a worktree delete its branch?

Not by default. `ygg remove` removes the linked checkout after safety checks and keeps its branch.
In a terminal, Ygg also offers eligible local branches for deletion before final confirmation; no
branch is preselected. An unmerged branch is offered only with `--force` and is clearly labeled.
Scripts can request the same behavior explicitly with `--delete-branch --yes`, adding `--force`
when the branch is unmerged. The configured default branch, detached checkouts, and remote branches
are never deleted. `ygg prune` removes only stale administrative metadata and never deletes an
existing directory or branch.

### How do I remove Ygg from an existing repository?

Remove linked worktrees normally, prune registrations for folders that are already missing, then run
`ygg uninit`. The command previews its changes. `ygg uninit --apply` removes the workspace
configuration and metadata link but keeps the Git repository, branches, primary checkout, worktree
container, and `.ygg.yml`. Local files below the Ygg metadata directory require `--force`.
This includes workspace-local `.ygg/project.yml`; preview its removal before granting `--force`.

### Do I need a worktree for every branch?

No. Use them when simultaneous folders preserve meaningful context: a hotfix, review, long-running
job, or parallel agent. For a quick isolated change, normal branch switching may be simpler.

## Further reading

- [Official Git worktree documentation](https://git-scm.com/docs/git-worktree)
- [Yggdrasil and the worlds of Norse cosmology](https://www.worldhistory.org/article/1305/nine-realms-of-norse-cosmology/)
- [DataCamp: Git Worktree Tutorial](https://www.datacamp.com/tutorial/git-worktree-tutorial)
- [Ygg CLI reference](cli-reference.md)
- [Ygg configuration](configuration.md)
