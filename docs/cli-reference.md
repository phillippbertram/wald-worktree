# CLI reference

This document describes the complete public `ygg` command surface. Run `ygg <command> --help` for the
same signatures and concise inline examples.

For the underlying mental model and visual workflows, start with
[Worktrees explained](worktrees.md).

## General behavior

```text
ygg [--version] [--help] <command>
```

Run `ygg` without a command for the guided menu. Direct commands are deterministic and are preferred
for scripts and agents. After an action completes, its output remains visible until `Esc` refreshes
the workspace state and returns to the action list or the session is explicitly closed. Expected
command errors use the same result view instead of immediately reopening the menu.

Interactive prompts use the same navigation throughout:

| Input | Behavior |
| --- | --- |
| `Esc` | Return one prompt step; cancel at a command's first prompt; exit from the main menu. |
| `Ctrl-C` | Exit the complete Ygg process with status 130. |

Entered values and selections are retained when moving back. `No`, empty text, and empty checkbox
selections remain regular answers rather than cancellation signals. Navigation does not cross an
already completed workspace or worktree mutation.

A worktree identifier may be its directory name, branch, or path. When an optional identifier is
omitted, `ygg` uses the current worktree, the only worktree, or an interactive selection. Without a
terminal, ambiguous selection is an error.

Commands discover the workspace from its root, a linked worktree, or a retained primary checkout.
Failures use a non-zero exit status. Interrupted foreground tasks exit with status 130.

Human-readable tables, previews, selections, and status messages highlight worktree names,
branches, paths, commands, states, warnings, and destructive actions when color is supported. Set
`NO_COLOR=1` to disable color. Machine-readable JSON, completion data, `ygg cd`, and
`ygg create --print-path` and `ygg handoff --print-path` never add presentation formatting.

## `ygg init`

```text
ygg init [repository] [directory]
ygg init --adopt [path] [options]
```

Without explicit arguments in a terminal, `ygg init` inspects the current directory and guides the
user through keeping an existing checkout or creating a standalone workspace. Outside a Git
repository, it offers separate paths for cloning a remote URL or selecting a local checkout or bare
repository. A selected local repository gets the same keep-or-copy choice. With `repository`, the
direct command clones a remote or local repository into a standalone workspace. Its default flat
layout is [Ygg Flow](worktrees.md#ygg-flow); `--worktrees-dir` selects a grouped alternative.

The guided flow validates the target, previews absolute paths and the resulting directory tree, then
asks `Initialize this workspace?`. Workspace creation, the optional default-branch worktree, and
the optional project-configuration wizard are separate phases. The wizard recommends the local
`.ygg/project.yml`; declining a later phase keeps the initialized workspace and prints the
corresponding next command.

The source, repository settings, destination, worktree layout, and final plan form a navigable
sequence. After workspace creation, `Esc` only cancels the optional worktree or project-automation
phase; it cannot return to the source or layout choices.

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
| `--worktrees-dir <path>` | Worktree parent. Defaults to the Ygg Flow root; a custom standalone path must remain inside the workspace root. |
| `--remote <name>` | Remote used for fetch and branch resolution. |
| `--no-remote` | Configure a local-only repository. |
| `--default-branch <branch>` | Default creation base and merge-check target. |
| `--config` | Create detected workspace-local project configuration in `.ygg/project.yml`. |
| `--config-scope <scope>` | With `--config`, write to `workspace` (default) or `project` (`.ygg.yml`). |
| `--yes` | Accept resolved settings without prompting. |

Non-interactive adoption requires `--adopt` and `--yes`. Clone mode cannot be combined with adoption
options. Initialization never moves or deletes an existing checkout and never commits `.ygg.yml`.
It also never copies or removes repository configuration unless an explicit config command requests
the copy.
Direct and non-interactive invocations do not show the guided preview.

When the repository already has a valid Ygg configuration, `init` verifies its local infrastructure.
It recreates a missing worktree container, adopted-workspace `.ygg` link, or `shared` directory and
reports `Repaired workspace`. It does not recreate individual worktrees or change workspace settings;
use `ygg prune` first if manually deleted worktrees still have stale Git registrations.

```sh
ygg init git@github.com:example/project.git ~/dev/project
ygg init git@github.com:example/project.git ~/dev/project --worktrees-dir worktrees
ygg init --adopt . --worktrees-dir ../project-worktrees --yes
```

## `ygg create`

```text
ygg create [branch] [options]
```

| Option | Meaning |
| --- | --- |
| `--from <commit-ish>` | Base for a new branch. Existing branches ignore it. |
| `--name <directory>` | Override the directory derived from the branch. |
| `--fetch` / `--no-fetch` | Override the project fetch default. |
| `--carry` | Create a new branch at the current `HEAD` and copy its local code state. |
| `--cd` | Enter through shell integration after setup. |
| `--open` | Open with the configured or interactively selected tool. |
| `--tool <profile>` | Open with a specific built-in or project profile; implies `--open`. |

`--cd` cannot be combined with `--open` or `--tool`. Without a branch, a terminal offers local and
remote candidates plus new-branch creation; non-interactive use requires a branch.

`--carry` must run inside a concrete worktree and cannot be combined with `--from`. Its target must
be a new local branch with no matching local or configured-remote ref. Ygg starts at the source's
exact `HEAD` and reproduces its staged, unstaged, and non-ignored untracked files, including binary
content, executable modes, and symlinks. Ignored files, empty directories, and submodules are not
copied. A clean source is valid and behaves like normal creation with an explicit notice.

Carry rejects unmerged entries, active merge/rebase/cherry-pick state, sparse checkouts, dirty
submodules, and unsupported special files before creating the target. The source is fingerprinted
before and after transfer and is never cleaned or modified by the transfer. Before `post_create`, a
failed application rolls back the new worktree and branch only while Ygg has verified that the
target is still clean and no write was attempted. Once a transfer may have written data, Ygg keeps
the target and branch and prints a recovery path for manual inspection. A failed `post_create`
keeps the fully transferred worktree and reports
`ygg setup <worktree>` as usual.

Resolution order is local branch, matching configured remote branch, then a new branch from
`--from` or the default branch. Creation runs trusted `pre_create`, Git checkout creation, then
`post_create`. A matching remote branch tracks its same-named remote ref. A new branch has no
upstream: its start point determines history only and never implies tracking, including when the
start point is `origin/<default-branch>`. With a configured remote, Ygg prints
`git push -u <remote> HEAD` as the explicit publish command. A failed `post_create` keeps the
checkout and reports `ygg setup <worktree>`.

Built-in tools are `claude`, `code`, `codex`, `codex-app`, `cursor`, and `zed`.

```sh
ygg create feature/payment --cd
ygg create hotfix/payment --from release/1.x --cd
ygg create feature/review --tool codex
ygg create feature/review --carry --cd
```

## `ygg handoff`

```text
ygg handoff [branch] [options]
```

`handoff` delegates to the exact `create --carry` lifecycle. It accepts `--name`,
`--fetch`/`--no-fetch`, `--cd`, `--open`, and `--tool`; carry is implicit and `--from` is not
available. Without a branch, a terminal asks only for a new branch name. Without a navigation
option, the result includes the matching `ygg cd` command.

This is a code handoff only. It copies local Git and file state while keeping the source unchanged;
it does not transfer a running editor, process, or agent session.

```sh
ygg handoff feature/review --cd
ygg handoff feature/review --tool codex
```

## `ygg status`

```text
ygg status [--json]
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
exit successfully. Use `ygg list --json` for complete individual worktree records.

```json
{"workspace":{"root":"/dev/project","defaultBranch":"main"},"current":null,"project":null,"worktrees":{"total":1,"clean":1,"modified":0,"locked":0,"missing":0,"unavailable":0}}
```

## `ygg list`

```text
ygg list|ls [--json]
```

Lists each worktree's name, branch, role, state, and path. `--json` emits the complete
machine-readable worktree records. `ls` is an alias for `list`. States are `clean`, `modified`,
`locked`, `missing`, or `unavailable`; roles are `primary` or `linked`. `unavailable` means the
directory exists but Ygg could not safely read its Git status; removal and rename remain blocked.

```json
[{"name":"main","role":"primary","path":"/dev/project/main","head":"abc123","branch":"main","branchRef":"refs/heads/main","locked":false,"lockReason":null,"prunable":false,"state":"clean"}]
```

## `ygg cd`

```text
ygg cd [worktree]
```

Prints the canonical worktree path. The shell wrapper consumes this path and changes the parent
shell's directory. Without shell integration, use the printed path with a normal `cd`.

## `ygg open`

```text
ygg open [worktree] [--tool <profile>]
```

Opens the selected worktree using a built-in or effective project-configuration tool profile. The
project default is used when available. Otherwise a terminal prompts; non-interactive use requires
`--tool`. Executable project profiles require trusted configuration. `{path}` is expanded before
availability checks; relative executable paths resolve from the selected worktree.

## `ygg exec`

```text
ygg exec [worktree] -- <command> [arguments...]
```

Runs the argument array directly in the selected worktree without a shell. Keep `--` before the
command so its options are not parsed by `ygg`.

```sh
ygg exec feature-payment -- pnpm test
```

When the command is omitted in a terminal, `ygg` prompts and explicitly runs the entered text through
`/bin/sh`. Non-interactive execution requires both the worktree and command.

## `ygg run`

```text
ygg run [task] [worktree]
```

Runs a named effective project-configuration task in the selected worktree. Omitting the task opens
an interactive task selection; non-interactive use requires the task name. Tasks require trusted
project configuration and stream command output in the foreground. Every named task receives its
own `Task` block with resolved worktree, branch, target path, command, and working directory. Each
step prints `RUNNING` before execution followed by its result; configured environment values are
not printed.

```sh
ygg run verify feature-payment
ygg run dev feature-payment
```

## `ygg hook run`

```text
ygg hook run <event> [worktree]
```

Runs one hook from the latest effective project configuration. `<event>` is `pre_create`,
`post_create`, `pre_remove`, or `post_remove`. The configuration must be trusted and contain at
least one step for the selected event.

This command runs only the configured steps; it never creates or removes a worktree. Every manual
run uses an existing selected worktree as `YGG_WORKTREE_PATH`. Consequently, manual `pre_create`
and `post_remove` runs are useful for testing behavior but do not reproduce the absent-target state
of their automatic lifecycle phase; Ygg prints a warning for these events.

In a terminal, automation output shows an animated spinner for the active configured step, groups
each step, nests concrete copy/symlink results, and summarizes their outcomes. Command steps keep
the latest ten lines visible beneath the spinner and retain their complete output afterward.
Redirected output preserves the append-only `RUNNING` and result rows with raw child output. An
already correct symlink is `UNCHANGED`; a configured `on_existing: skip` conflict is `SKIPPED` and
does not fail the hook. Each hook has its own labeled block, and consecutive lifecycle hooks remain
separated. See
[configuration](configuration.md#file-steps) for conflict policies and status meanings.

```sh
ygg hook run post_create feature-payment
ygg hook run pre_remove feature-payment
```

## `ygg setup`

```text
ygg setup [worktree]
```

Compatibility shortcut for `ygg hook run post_create [worktree]`. This remains the recovery path
after setup failed during creation. The effective project configuration must be trusted and contain
at least one `post_create` step. It uses the same structured automation output and conflict policies
as the general hook command.

## `ygg rename`

```text
ygg rename [worktree] [new-name]
```

Renames only a linked worktree directory through Git; the branch, upstream, `HEAD`, index, and files
stay unchanged. Both arguments are required without a terminal. Interactive use selects an eligible
worktree and asks for the new directory name.

Only direct children of the configured worktree directory are eligible. Ygg refuses the primary or
current checkout, external, missing, or locked worktrees, and worktrees whose index contains a
submodule. The destination uses the normal worktree-name and path validation and must not already
exist, including as a dangling symlink. Dirty worktrees are allowed. There is no `--force` option
and rename runs no project hooks or trusted executable configuration.

```sh
ygg rename feature-payment payment-review
```

## `ygg remove`

```text
ygg remove [worktrees...] [--delete-branch] [--force] [--yes]
```

Without identifiers, a terminal offers removable linked worktrees. Non-interactive use requires
explicit identifiers and `--yes`. An interactive terminal offers each eligible merged local branch
for deletion; the safe default keeps every branch. That branch choice also confirms the removal, so
Ygg does not ask the same question again. Multiple eligible branches use an unselected checkbox
list. When no branch choice is available, Ygg retains a separate removal confirmation. `--yes`
without `--delete-branch` keeps every branch.

| Option | Meaning |
| --- | --- |
| `--force` | Bypass dirty, unmerged, and lock safeguards. |
| `--delete-branch` | Delete each removed worktree's eligible merged local branch. |
| `--yes` | Confirm removal without prompting. |

The three bypassable safeguards are staged, unstaged, or untracked changes; a branch not merged
into the configured default branch; and a Git worktree lock. With `--force`, Ygg prints the branch,
path, and every bypassed safeguard before confirmation, including with `--yes`.

The retained primary checkout and a worktree whose state is unavailable are hard blockers and
cannot be bypassed. Duplicate identifiers resolving to the same worktree are removed once. Branches
are kept unless selected interactively or requested with `--delete-branch`. Only a local branch that
is merged into the configured default branch is eligible; the default branch, detached checkouts,
unmerged branches, and remote branches are never deleted. `--force` alone never selects a branch
for deletion, and `--delete-branch` rejects the entire plan before mutation if any selected worktree
has an ineligible branch. Trusted `pre_remove` and `post_remove` hooks run around Git removal; an
eligible branch is deleted only after `post_remove` succeeds and its identity is revalidated.

## `ygg prune`

```text
ygg prune
ygg prune --apply [--yes] [--json]
```

`ygg prune` previews registrations whose worktree directory is missing and which Git considers
pruneable with `--expire now`. It does not change metadata.

`--apply` delegates cleanup to `git worktree prune --expire now`. A terminal asks for confirmation;
non-interactive application requires `--apply --yes`. `--yes` without `--apply` is invalid.

Pruning removes only stale Git administrative metadata. It never removes a directory or branch,
does not run project hooks, and preserves locked worktrees.
`--json` emits one object with `action` (`none`, `preview`, or `applied`) and `worktrees`.

## `ygg uninit`

```text
ygg uninit
ygg uninit --apply [--force] [--yes] [--json]
```

`ygg uninit` previews the Ygg workspace metadata and adopted-workspace `.ygg` link that would be
removed. The Git database, branches, retained primary checkout, worktree container, project-owned
`.ygg.yml`, and every other directory are kept.

`--apply` performs the removal after confirmation. Non-interactive application requires
`--apply --yes`; `--yes` and `--force` are invalid without `--apply`. Registered linked worktrees,
including missing or locked registrations, always block uninitialization. Remove existing worktrees
with `ygg remove` and clean missing registrations with `ygg prune --apply` first.

Files or additional directories below the Ygg metadata directory are local data. This includes
`.ygg/project.yml` and content below `shared`. Uninitialization preserves them by default and
requires `--force` to discard them. Project hooks are not run.
`--json` emits the action, remove/keep paths, blocking worktrees, and local data entries.

## `ygg config`

```text
ygg config [--json]
ygg config init [worktree] [--scope workspace|project] [--from-project] [--yes] [--force]
ygg config trust [--yes]
ygg config untrust [--yes]
```

`ygg config` prints normalized workspace YAML followed by absolute workspace, worktree, shared-file,
repository-project, workspace-project, and effective configuration data, including the semantic
behavior hash and trust state.
`--json` emits normalized workspace configuration, derived paths, and the nullable effective
project record as one object.

| Command | Meaning |
| --- | --- |
| `config init` | Generate local `.ygg/project.yml` from detected Node conventions and guided choices. |
| `config init --scope project` | Generate repository-owned `.ygg.yml` explicitly. |
| `config init --scope workspace --from-project` | Copy the complete `.ygg.yml` locally without deleting it. |
| `config init --yes` | Use detected defaults without prompting. |
| `config init --force` | Replace existing configuration at the selected scope. |
| `config trust` | Review and trust the current/default project behavior until it changes. |
| `config untrust` | Remove locally recorded trust. |

Non-interactive trust and untrust require `--yes`. See [configuration](configuration.md) for the
complete schema and trust model.

## `ygg completion`

```text
ygg completion <bash|zsh|fish>
```

Prints the navigation function and dynamic completion definitions used by `ygg cd`,
`ygg create --cd`, and interactive tab completion.

```sh
eval "$(ygg completion zsh)"
eval "$(ygg completion bash)"
ygg completion fish | source
```
