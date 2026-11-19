---
title: "CLI reference"
description: "Commands, flags, JSON output, prompts, and safety rules."
---

This page lists every public `wald` command and option. Run `wald <command> --help` for the same
signature and a few examples in the terminal.

If worktrees are new to you, start with [Worktrees explained](worktrees.md).

wald release binaries support macOS and Linux on x64 and ARM64 and require Git 2.31.0 or newer.
See [Install wald](getting-started.md#install-wald) for the installer and GitHub Release downloads.
Git 2.31 introduced the `rev-parse --path-format` behavior used for canonical common-directory
resolution ([release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.31.0.adoc)).

## General behavior

```text
wald [-C <path>] [--no-input] [--version] [--help] <command>
```

Run `wald` in a terminal for the guided menu. **Worktrees…** offers actions for a selected
checkout. The current and primary checkouts are excluded from rename and removal in the menu.
Without a terminal, running `wald` alone prints help.

`Esc` goes back one prompt and retains previous answers. At the first prompt it cancels the
command, and at the main menu it exits. Going back never undoes a completed mutation.
`Ctrl-C` exits with status 130.

A worktree identifier may be its directory name, branch, or path. When an optional identifier is
omitted, `wald` uses the current worktree, the only worktree, or an interactive selection. Without a
terminal, ambiguous selection is an error.

Commands discover the workspace from its root, a linked worktree, or a retained primary checkout.
Failures use a non-zero exit status. Interrupted foreground tasks exit with status 130.

### Working directory

Use the global `-C <path>` or `--directory <path>` option to run wald from an existing directory.
Workspace discovery, the current worktree, and relative input paths use that directory. Without a
command, `wald -C <path>` opens the guided menu there. `handoff` and `create --carry` use the selected
worktree as their source; their preservation and trust checks remain unchanged.

```sh
wald -C ~/dev/project status
wald -C ~/dev/project create feature/payment
wald -C ~/dev/project/main handoff feature/review
wald -C ~/dev/project -C main status --json
```

Relative paths resolve from the current directory. Repeated `-C` options resolve in order, each
relative to the preceding directory. Absolute paths replace that context; symlinks resolve to their
actual directory. Empty, missing, inaccessible, or non-directory paths fail before command execution.
`-Cpath` and `--directory=path` are also supported. Quote paths containing spaces. Global options may
appear before or after the subcommand; arguments after `--` are not interpreted as wald options.

`-C` alone does not change the invoking shell's directory. With shell integration, `wald -C <path>
cd <worktree>` and `wald -C <path> create <branch> --cd` explicitly navigate after success. A failed
command leaves the shell in its previous directory. `-C` grants neither confirmation nor trust.

### Unattended commands

Pass the global `--no-input` before or after a command to disable wald prompts, even in a terminal.
Without a subcommand it prints help. Supply required arguments and confirmation flags explicitly.
An unresolved choice or missing trust produces an error. Commands that support `--json` follow
the same input rules. Configured tasks and hooks receive EOF on stdin in these modes.
Programs explicitly started by `exec` or opened as tools retain their own I/O. Arguments after
`exec … --` belong to the child program.

### Output

`--json` selects machine-readable output and disables Wald prompts. Mutating commands still
require their usual authorization and trust.
Successful commands write exactly one JSON document to stdout. Hook and
child-process output stays on stderr. Operational failures keep stdout empty and write a redacted
JSON error with `message` and `exitCode` to stderr. `doctor` is the exception for diagnosed state:
it always returns its report on stdout and exits 1 when that report contains a failing check.

Human-readable tables, previews, selections, and status messages highlight worktree names,
branches, paths, commands, states, warnings, and destructive actions when color is supported. Set
`NO_COLOR=1` to disable color. Machine-readable JSON, completion data, `wald cd`, and
`wald create --print-path` and `wald handoff --print-path` never add presentation formatting.

## `wald init`

```text
wald init [repository] [directory]
wald init --adopt [path] [options]
```

In a terminal, `wald init` without arguments looks at the current directory and asks whether to keep
an existing checkout or create a standalone workspace. Outside a Git repository, it can clone a
remote URL or use a local checkout or bare repository. A selected local repository gets the same
keep-or-copy choice. With `repository`, the direct command clones a remote or local repository into
a standalone workspace. Its default flat layout is [Wald Flow](worktrees.md#wald-flow);
`--worktrees-dir` selects a grouped alternative.

Guided initialization previews the destination paths and layout before writing. After creation,
the default-branch worktree and local project configuration are optional. Cancelling either
keeps the workspace and prints the next command.

When retaining a checkout, relative worktree-directory names resolve beside it and absolute paths
are used directly. A bare source is described as a repository rather than a checkout. Local
standalone clones use independent object files without hardlinks; working-tree and ignored files,
stashes, and detached commits without a branch are not copied. Empty repositories without a
committed branch are not supported yet. See [workspace layouts](worktrees.md#workspace-layouts) for
the visual comparison.

| Argument or option | Meaning |
| --- | --- |
| `repository` | Remote URL or local repository to clone. |
| `directory` | Destination workspace; otherwise derived from the repository name. |
| `--adopt [path]` | Keep an existing checkout; omitted path means the current directory. |
| `--worktrees-dir <path>` | Worktree parent. Defaults to the Wald Flow root; a custom standalone path must remain inside the workspace root. |
| `--remote <name>` | Remote used for fetch and branch resolution. |
| `--no-remote` | Configure a local-only repository. |
| `--default-branch <branch>` | Default creation base and merge-check target. |
| `--config` | Create detected workspace-local project configuration in `.wald/project.yml`. |
| `--config-scope <scope>` | With `--config`, write to `workspace` (default) or `project` (`.wald.yml`). |
| `--yes` | Accept resolved settings without prompting. |
| `--json` | Emit the initialization action, normalized workspace, and restored entries without prompting. |

Unattended adoption requires `--adopt --yes`. Direct commands skip the guided preview.
Cloning rejects adoption-only options and nonempty destinations. Initialization preserves the
original checkout and never commits `.wald.yml`. The JSON action is `initialized`, `repaired`,
or `unchanged`.

When the repository already has a valid wald configuration, `init` verifies its local infrastructure.
It recreates a missing worktree container, adopted-workspace `.wald` link, or `shared` directory and
reports `Repaired workspace`. It does not recreate individual worktrees or change workspace settings;
use `wald prune` first if manually deleted worktrees still have stale Git registrations.

```sh
wald init git@github.com:example/project.git ~/dev/project
wald init git@github.com:example/project.git ~/dev/project --worktrees-dir worktrees
wald init --adopt . --worktrees-dir ../project-worktrees --yes
```

## `wald create`

Alias: `wald plant`. It accepts the same arguments and options; this reference uses the canonical
`create` name throughout.

```text
wald create [branch] [options]
```

| Option | Meaning |
| --- | --- |
| `--from <commit-ish>` | Base for a new branch. Existing branches ignore it. |
| `--name <directory>` | Override the directory derived from the branch. |
| `--fetch` / `--no-fetch` | Override the project fetch default. |
| `--carry` | Create a new branch at the current `HEAD` and copy its local code state. |
| `--skip-hooks` | Skip all `pre_create` and `post_create` steps for this invocation, including commands, copies, and symlinks. |
| `--cd` | Enter through shell integration after setup. |
| `--open` | Open with the configured or interactively selected tool. |
| `--tool <profile>` | Open with a specific built-in or project profile; implies `--open`. |
| `--json` | Create the worktree and emit its strategy, worktree record, and optional carry report. |

`--cd` cannot be combined with `--open` or `--tool`. Without a branch, a terminal offers local and
remote candidates plus new-branch creation; non-interactive use requires a branch.

The branch picker marks branches already checked out. Guided creation previews the branch,
directory, hooks, and destination. You can revise them without fetching again. Cancelling keeps
the branches and worktrees and runs no hooks. A fetch during preparation may already have updated
remote refs. Supplying a branch skips this review.

Skipping hooks needs no trust approval for creation and does not save or change configuration trust.
Configuration validation, Git safety checks, and carry verification still apply. Opening afterward
with `--open` or `--tool` retains its own trust check. Run `wald setup <worktree>` later to execute
`post_create` with the usual trust requirement; skipping is not persisted.

JSON mode requires a branch and cannot be combined with `--cd`, `--open`, `--tool`, or the internal
shell-integration option `--print-path`.

For unattended `--open`, supply `--tool` or set `defaults.tool`. Wald checks for a missing choice
or unknown profile before running create hooks or creating the worktree. Tool startup happens
after setup so a tool installed by a hook can run. If opening fails, the error identifies the
created checkout and gives a command to retry opening it.

`--carry` must run inside a concrete worktree and cannot be combined with `--from`. Its target must
be a new local branch with no matching local or configured-remote ref. wald starts at the source's
exact `HEAD` and reproduces its staged, unstaged, and non-ignored untracked files, including binary
content, executable modes, and symlinks. Ignored files, empty directories, and submodules are not
copied. A clean source is valid and behaves like normal creation with an explicit notice.

Carry rejects unmerged entries, active merge/rebase/cherry-pick state, sparse checkouts, dirty
submodules, and unsupported special files before creating the target. The source is fingerprinted
before and after transfer and is never cleaned or modified by the transfer. Before `post_create`, a
failed application rolls back the new worktree and branch only while wald has verified that the
target is still clean and no write was attempted. Once a transfer may have written data, wald keeps
the target and branch and prints a recovery path for manual inspection. A failed `post_create`
keeps the fully transferred worktree and reports
`wald setup <worktree>` as usual.

Resolution order is local branch, matching configured remote branch, then a new branch from
`--from` or the default branch. By default, creation runs trusted `pre_create`, Git checkout creation,
then `post_create`. A matching remote branch tracks its same-named remote ref. A new branch has no
upstream: its start point determines history only and never implies tracking, including when the
start point is `origin/<default-branch>`. With a configured remote, wald prints
`git push -u <remote> HEAD` as the explicit publish command. A failed `post_create` keeps the
checkout and reports `wald setup <worktree>`.

Built-in tools are `claude`, `code`, `codex`, `codex-app`, `cursor`, and `zed`.

```sh
wald create feature/payment --cd
wald create hotfix/payment --from release/1.x --cd
wald create feature/review --tool codex
wald create feature/review --carry --cd
wald create feature/minimal --skip-hooks --cd
```

## `wald handoff`

```text
wald handoff [branch] [options]
```

`handoff` delegates to the exact `create --carry` lifecycle. It accepts `--name`,
`--fetch`/`--no-fetch`, `--skip-hooks`, `--cd`, `--open`, and `--tool`; carry is implicit and `--from`
is not available. Without a branch, a terminal asks for a new branch name. Without a navigation
option, the result includes the matching `wald cd` command.

The interactive handoff uses the same create-plan review, options, and back navigation as
`create`.
`--json` requires a branch and has the same destination-option conflicts as create.

This is a code handoff only. It copies local Git and file state while keeping the source unchanged;
it does not transfer a running editor, process, or agent session.

```sh
wald handoff feature/review --cd
wald handoff feature/review --tool codex
```

## `wald doctor`

```text
wald doctor [--json] [--verbose]
```

Runs a read-only diagnosis even outside a wald workspace or when workspace configuration is invalid.
Checks are `pass`, `warning`, `fail`, or `skipped` and cover the JavaScript runtime, Git 2.31.0, workspace
discovery, YAML syntax and schema, canonical path boundaries, Git common-directory and marker
identity, remote/default-branch refs, worktree registrations and intentional locks, project trust,
file-step sources, and configured argv/tool executables.

Node installations check the minimum Node.js version of 22.13.0 (`runtime.node`). The experimental
[Bun binary](binary-packaging.md) reports its bundled Bun version (`runtime.bun`) instead of Bun's
emulated Node version. A separate Node installation is not required for the binary; configured
hooks and tools can still require Node or other executables.

Doctor never fetches, repairs, changes trust, or runs hooks. It does not print remote URLs or
environment contents. Suggested commands such as `wald init`, `wald prune`, `git worktree repair`, or
`git worktree lock` remain explicit follow-up actions. No workspace is a warning with exit 0;
runtime, configuration, and consistency failures exit 1.

The default output groups checks into a concise runtime, workspace, repository, worktree, and
project summary. `--verbose` shows every individual check, identifier, skipped check, and safe
suggestion. `--json` emits the unchanged machine-readable `{status, checks}` report.

## `wald status`

```text
wald status [--json]
```

Prints a five-row dashboard for the invocation context: workspace and default branch, current
worktree, local upstream comparison, effective project-configuration trust, and aggregate worktree
state counts. From the workspace root, `Current` is `workspace root` and tracking is not applicable.

Tracking uses only existing local refs and never fetches. It reports `tracked` data as ahead and
behind counts, `none` when the branch has no upstream, `gone` when the configured upstream ref is
not available locally, and `not-applicable` for detached HEAD or the workspace root.

`--json` emits one object with `workspace`, nullable `current`, nullable `project`, and `worktrees`
fields. The current record includes its tracking state; project trust is `not-required`, `trusted`,
or `untrusted`. Modified, locked, missing, unavailable, untrusted, and gone states are informational and still
exit successfully. Use `wald list --json` for complete individual worktree records.

```json
{"workspace":{"root":"/dev/project","defaultBranch":"main"},"current":null,"project":null,"worktrees":{"total":1,"clean":1,"modified":0,"locked":0,"missing":0,"unavailable":0}}
```

## `wald list`

```text
wald list|ls [--json]
```

Lists each worktree's name, branch, role, state, and path. `--json` emits the complete
machine-readable worktree records. `ls` is an alias for `list`. States are `clean`, `modified`,
`locked`, `missing`, or `unavailable`; roles are `primary` or `linked`. `unavailable` means the
directory exists but wald could not safely read its Git status; removal and rename remain blocked.

```json
[{"name":"main","role":"primary","path":"/dev/project/main","head":"abc123","branch":"main","branchRef":"refs/heads/main","locked":false,"lockReason":null,"prunable":false,"state":"clean"}]
```

## `wald cd`

```text
wald cd [worktree]
```

Prints the canonical worktree path. The shell wrapper consumes this path and changes the parent
shell's directory. Without shell integration, use the printed path with a normal `cd`.

## `wald path`

`wald path [worktree]` prints the canonical checkout path on stdout, including when shell
integration is installed. Use it in scripts, for example `checkout=$(wald path feature/api)`.
Omitting the identifier selects the current checkout or the only worktree. An ambiguous target
opens a picker in a terminal and requires an explicit identifier for unattended use.

## `wald open`

```text
wald open [worktree] [--tool <profile>]
```

Opens the selected worktree using a built-in or effective project-configuration tool profile. The
project default is used when available. Otherwise a terminal prompts; non-interactive use requires
`--tool`. Executable project profiles require trusted configuration. `{path}` is expanded before
availability checks; relative executable paths resolve from the selected worktree.

## `wald exec`

```text
wald exec [worktree] -- <command> [arguments...]
```

Runs the argument array directly in the selected worktree without a shell. Keep `--` before the
command so its options are not parsed by `wald`.

```sh
wald exec -- pnpm test
wald exec feature-payment -- pnpm test
```

When the command is omitted in a terminal, `wald` prompts and explicitly runs the entered text through
`/bin/sh`. Unattended execution requires a command. The current or only worktree resolves an
omitted target. With several candidates at the workspace root, provide a worktree explicitly.

## `wald run`

```text
wald run [task] [worktree]
wald run --list [worktree] [--json]
```

Runs a named effective project-configuration task in the selected worktree. Omitting the task opens
an interactive task selection; non-interactive use requires the task name. Tasks require trusted
project configuration and stream command output in the foreground. Every named task receives its
own `Task` block with resolved worktree, branch, target path, command, and working directory. Each
step prints `RUNNING` before execution followed by its result; configured environment values are
not printed.

If a guided task selection has no configured tasks, wald offers project automation setup or a way
back. Supplying an explicit task still reports a missing task or configuration as an error.

`--list` reads the effective configuration for that checkout without running tasks or requiring
trust. With `--json`, the result contains the absolute `worktree` path and a `tasks` array sorted
by name. Each entry has a `name` and a nullable `description`. An empty array is a successful
listing. JSON output for `run` requires `--list`.

```sh
wald run verify feature-payment
wald run dev feature-payment
```

## `wald hook run`

```text
wald hook run <event> [worktree]
```

Runs one hook from the latest effective project configuration. `<event>` is `pre_create`,
`post_create`, `pre_remove`, or `post_remove`. The configuration must be trusted and contain at
least one step for the selected event.

This command runs only the configured steps; it never creates or removes a worktree. Every manual
run uses an existing selected worktree as `WALD_WORKTREE_PATH`. Consequently, manual `pre_create`
and `post_remove` runs are useful for testing behavior but do not reproduce the absent-target state
of their automatic lifecycle phase; wald prints a warning for these events.

In a terminal, automation output shows an animated spinner for the active configured step, groups
each step, nests concrete copy/symlink results, and summarizes their outcomes. Command steps keep
the latest ten lines visible beneath the spinner and retain their complete output afterward.
Redirected output preserves the append-only `RUNNING` and result rows with raw child output. An
already correct symlink is `UNCHANGED`; a configured `on_existing: skip` conflict is `SKIPPED` and
does not fail the hook. Each hook has its own labeled block, and consecutive lifecycle hooks remain
separated. See
[configuration](configuration.md#file-steps) for conflict policies and status meanings.

```sh
wald hook run post_create feature-payment
wald hook run pre_remove feature-payment
```

## `wald setup`

```text
wald setup [worktree]
```

Compatibility shortcut for `wald hook run post_create [worktree]`. This remains the recovery path
after setup failed during creation. The effective project configuration must be trusted and contain
at least one `post_create` step. It uses the same structured automation output and conflict policies
as the general hook command.

In a terminal, missing setup steps offer project automation setup or a way back. Non-interactive
use retains the missing-configuration or missing-hook error.

## `wald rename`

```text
wald rename [worktree] [new-name] [--branch <new-branch>] [--keep-branch] [--json]
```

Renames a linked worktree directory and its local branch through Git. By default, `new-name` is used
for both. `--branch <new-branch>` supplies a different local branch name, including names with `/`.
`--keep-branch` moves only the directory, preserving the current branch or detached `HEAD`.
The two options are mutually exclusive. The configured default branch and detached worktrees require
`--keep-branch` even when a separate `--branch` is supplied.

Unattended rename requires both arguments. Guided rename previews the paths and branch names
before applying the selected change.

Only direct children of the configured worktree directory are eligible. wald refuses the primary or
current checkout, external, missing, unavailable, or locked worktrees, and worktrees whose index contains a
submodule. The destination uses the normal worktree-name and path validation and must not already
exist, including as a dangling symlink. Dirty worktrees are allowed. There is no `--force` option
and rename runs no project hooks or trusted executable configuration. The new local branch must
have a valid literal Git ref name and must not collide with a local branch or existing target branch
configuration. A branch checked out in multiple worktrees cannot be renamed.

wald checks the path, branch identity, `HEAD`, and upstream before mutation. It renames the local
branch first, moves the directory, then verifies the resulting path, ref, `HEAD`, and upstream.
If a later step fails, it attempts to restore both steps after checking their identity. Concurrent
changes or an occupied original path/ref can prevent safe rollback; the error reports concrete
recovery guidance. Index, files, and file modes are preserved, including uncommitted work.

Upstream tracking stays unchanged: `payment-review` can still track `origin/feature/payment`.
Remote branches are never created, deleted, fetched, or pushed by rename. Human-readable output
shows `Branch renamed: feature/payment → payment-review` and, if configured,
`Upstream kept: origin/feature/payment`. Directory-only renames show `Branch kept: …`.

JSON mode requires both arguments and emits the previous name/path/branch plus the resulting
worktree and `branchChange`. `before` and `after` in `branchChange` are local branch names, or `null`
for a detached worktree. `upstream` is the existing tracking target, including a gone upstream, or
`null` when none is configured. `renamed` is false when the branch is kept or already has the requested name.

```sh
wald rename feature-payment payment-review
wald rename feature-payment payment-review --branch feature/payment-review
wald rename feature-payment payment-review --keep-branch
wald rename main main-checkout --keep-branch --json
```

```json
{
  "action": "renamed",
  "before": { "name": "feature-payment", "path": "/dev/project/feature-payment", "branch": "feature/payment" },
  "branchChange": { "before": "feature/payment", "after": "payment-review", "renamed": true, "upstream": "origin/feature/payment" },
  "worktree": { "name": "payment-review", "path": "/dev/project/payment-review", "branch": "payment-review", "role": "linked", "state": "modified", "head": "abc123" }
}
```

## `wald remove`

```text
wald remove [worktrees...] [--dry-run] [--delete-branch] [--force] [--yes] [--json]
```

Run `wald remove` to select worktrees, or pass names, branches, or paths. The picker excludes
the primary and current checkouts. The single-target action confirms removal. For a batch,
review all branch decisions together. **Cancel** is the default. Discarding local changes,
unmerged work, or a lock requires an explicit force decision. Executable hooks require trust.

| Option | Meaning |
| --- | --- |
| `--dry-run` | Inspect the requested operation and return immediately after the preview. |
| `--delete-branch` | Request deletion of each selected worktree's local branch. |
| `--force` | Allow bypassing dirty, unmerged, and lock safeguards. |
| `--yes` | Confirm removal of the named worktrees; keep branches unless deletion was requested. |
| `--json` | Emit a machine-readable preview or removal result. |

`wald remove feature-api feature-ui --delete-branch --dry-run --json` returns `action: "preview"`,
the modeled `force` setting, `blocked`, and an entry for each distinct worktree. Each entry includes
its name, path, branch, `branchAction` (keep, delete, none, or blocked), `branchReason`, `forceReasons`,
`hardBlockers`, and `requiresTrust`. The batch is blocked when any hard blocker, missing force
permission, or missing trust prevents the requested operation. Confirmation via `--yes` is only
required for unattended execution. Exit 0 means inspection succeeded, including for blocked
plans. Unknown or ambiguous identifiers and inspection failures use the normal error contract.
A dry run runs no hooks and writes no trust decision. Each execution builds a fresh plan.

The retained primary checkout and a worktree whose state is unavailable are hard blockers and
cannot be bypassed. Duplicate identifiers resolving to the same worktree are removed once. Branches
are kept unless selected interactively or requested with `--delete-branch`. A local branch with a
known HEAD is eligible unless it is the configured default branch. Deleting an unmerged branch
additionally requires interactive force consent or `--force`; neither alone selects a branch for
deletion. Detached checkouts and remote branches are never deleted, and `--delete-branch` rejects the entire plan
before mutation if any selected worktree has an ineligible branch. Trusted `pre_remove` and
`post_remove` hooks run around Git removal; an eligible branch is deleted only after `post_remove`
succeeds and its identity is revalidated.
JSON mode requires explicit worktrees and either `--dry-run` or `--yes`.

If execution stops partway through a batch, the JSON error's `effects` includes
`completedWorktrees`, `failedWorktree`, and `pendingWorktrees` in request order.
`removedWorktrees`, `deletedBranches`, and `keptBranches` describe effects across the batch.
A failed target can already appear in `removedWorktrees` if its post-remove hook failed.

```sh
wald remove feature-api feature-ui --delete-branch --dry-run --json

wald remove feature-api feature-ui --delete-branch --yes
```

## `wald prune`

```text
wald prune
wald prune --apply [--yes] [--json]
```

`wald prune` previews registrations whose worktree directory is missing and which Git considers
pruneable with `--expire now`. It does not change metadata.

`--apply` delegates cleanup to `git worktree prune --expire now`. A terminal asks for confirmation;
non-interactive application requires `--apply --yes`. `--yes` without `--apply` is invalid.

Pruning removes only stale Git administrative metadata. It never removes a directory or branch,
does not run project hooks, and preserves locked worktrees.
`--json` emits one object with `action` (`none`, `preview`, or `applied`) and `worktrees`.

## `wald uninit`

```text
wald uninit
wald uninit --apply [--force] [--yes] [--json]
```

`wald uninit` previews the wald workspace metadata and adopted-workspace `.wald` link that would be
removed. The Git database, branches, retained primary checkout, worktree container, project-owned
`.wald.yml`, and every other directory are kept.

`--apply` performs the removal after confirmation. Non-interactive application requires
`--apply --yes`; `--yes` and `--force` are invalid without `--apply`. Registered linked worktrees,
including missing or locked registrations, always block uninitialization. Remove existing worktrees
with `wald remove` and clean missing registrations with `wald prune --apply` first.

Files or additional directories below the wald metadata directory are local data. This includes
`.wald/project.yml` and content below `shared`. Uninitialization preserves them by default and
requires `--force` to discard them. Project hooks are not run.
`--json` emits the action, remove/keep paths, blocking worktrees, and local data entries.

## `wald config`

```text
wald config [--json]
wald config init [worktree] [--scope workspace|project] [--from-project] [--yes] [--force] [--json]
wald config trust [--yes] [--json]
wald config untrust [--yes] [--json]
```

`wald config` prints normalized workspace YAML followed by absolute workspace, worktree, shared-file,
repository-project, workspace-project, and effective configuration data, including the semantic
behavior hash and trust state.
`--json` emits normalized workspace configuration, derived paths, and the nullable effective
project record as one object.

On success the configuration subcommands emit a JSON object in JSON mode with action `configured`,
`trusted`, or `untrusted`. Initialization also reports the written scope and path and the
effective behavior hash. Trust reports the approved configuration path and hash.

| Command | Meaning |
| --- | --- |
| `config init` | Generate local `.wald/project.yml` from detected Node conventions and guided choices. |
| `config init --scope project` | Generate repository-owned `.wald.yml` explicitly. |
| `config init --scope workspace --from-project` | Copy the complete `.wald.yml` locally without deleting it. |
| `config init --yes` | Use detected defaults without prompting. |
| `config init --force` | Replace existing configuration at the selected scope. |
| `config trust` | Review and trust the current/default project behavior until it changes. |
| `config untrust` | Remove locally recorded trust. |

Non-interactive trust and untrust require `--yes`. See [configuration](configuration.md) for the
complete schema and trust model.

## `wald completion`

```text
wald completion <bash|zsh|fish>
```

Prints the navigation function and dynamic completion definitions used by `wald cd`,
`wald create --cd`, and interactive tab completion.

Zsh completion requires `compinit` to be initialized before loading the generated definitions.
Bash navigation and completion work in Apple's Bash 3.2 and newer versions. When bash-completion
is loaded, wald uses its word parsing helper; otherwise it uses Bash's completion words directly.

Completion offers directory paths for `-C` and `--directory`, then resolves branches, worktrees,
tasks, and tools in the selected workspace. Repeated directory options use the same relative-path
semantics as execution. Completion requests pass arguments literally, including spaces and shell
metacharacters. Reload the generated integration in existing shells after updating wald.

```sh
eval "$(wald completion zsh)"
eval "$(wald completion bash)"
wald completion fish | source
```
