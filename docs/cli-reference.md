# CLI reference

This document describes the complete public `ygg` command surface. Run `ygg <command> --help` for the
same signatures and concise inline examples.

## General behavior

```text
ygg [--version] [--help] <command>
```

Run `ygg` without a command for the guided menu. Direct commands are deterministic and are preferred
for scripts and agents.

A worktree identifier may be its directory name, branch, or path. When an optional identifier is
omitted, `ygg` uses the current worktree, the only worktree, or an interactive selection. Without a
terminal, ambiguous selection is an error.

Commands discover the workspace from its root, a linked worktree, or a retained primary checkout.
Failures use a non-zero exit status. Interrupted foreground tasks exit with status 130.

## `ygg init`

```text
ygg init [repository] [directory]
ygg init --adopt [path] [options]
```

Without explicit arguments in a terminal, `ygg init` inspects the current directory and guides the
user through keeping an existing checkout or creating a standalone workspace. With `repository`, it
clones a remote or local Git repository into a standalone workspace.

| Argument or option | Meaning |
| --- | --- |
| `repository` | Remote URL or local repository to clone. |
| `directory` | Destination workspace; otherwise derived from the repository name. |
| `--adopt [path]` | Keep an existing checkout; omitted path means the current directory. |
| `--worktrees-dir <path>` | Worktree parent. In standalone mode it must remain inside the workspace root. |
| `--remote <name>` | Remote used for fetch and branch resolution. |
| `--no-remote` | Configure a local-only repository. |
| `--default-branch <branch>` | Default creation base and merge-check target. |
| `--config` | Offer or create a detected `.ygg.yml` in the retained checkout. |
| `--yes` | Accept resolved settings without prompting. |

Non-interactive adoption requires `--adopt` and `--yes`. Clone mode cannot be combined with adoption
options. Initialization never moves or deletes an existing checkout and never commits `.ygg.yml`.

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
| `--cd` | Enter through shell integration after setup. |
| `--open` | Open with the configured or interactively selected tool. |
| `--tool <profile>` | Open with a specific built-in or project profile; implies `--open`. |

`--cd` cannot be combined with `--open` or `--tool`. Without a branch, a terminal offers local and
remote candidates plus new-branch creation; non-interactive use requires a branch.

Resolution order is local branch, matching configured remote branch, then a new branch from
`--from` or the default branch. Creation runs trusted `pre_create`, Git checkout creation, then
`post_create`. A failed `post_create` keeps the checkout and reports `ygg setup <worktree>`.

Built-in tools are `claude`, `code`, `codex`, `codex-app`, `cursor`, and `zed`.

```sh
ygg create feature/payment --cd
ygg create hotfix/payment --from release/1.x --cd
ygg create feature/review --tool codex
```

## `ygg list`

```text
ygg list [--json]
```

Lists each worktree's name, branch, role, state, and path. `--json` emits the complete
machine-readable worktree records. States are `clean`, `modified`, `locked`, or `missing`; roles are
`primary` or `linked`.

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

Opens the selected worktree using a built-in or `.ygg.yml` tool profile. The project default is used
when available. Otherwise a terminal prompts; non-interactive use requires `--tool`. Executable
project profiles require trusted configuration.

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

Runs a named `.ygg.yml` task in the selected worktree. Omitting the task opens an interactive task
selection; non-interactive use requires the task name. Tasks require trusted project configuration
and stream command output in the foreground.

```sh
ygg run verify feature-payment
ygg run dev feature-payment
```

## `ygg setup`

```text
ygg setup [worktree]
```

Re-runs the configured `post_create` steps. This is the recovery path after setup failed during
creation. The selected worktree must contain a trusted `.ygg.yml` with at least one `post_create`
step.

## `ygg remove`

```text
ygg remove [worktrees...] [--force] [--yes]
```

Without identifiers, a terminal offers removable linked worktrees. Non-interactive use requires
explicit identifiers and `--yes`.

| Option | Meaning |
| --- | --- |
| `--force` | Bypass dirty, unmerged, and lock safeguards. |
| `--yes` | Confirm removal without prompting. |

The retained primary checkout is always protected. Branches are never deleted. Trusted
`pre_remove` and `post_remove` hooks run around Git removal.

## `ygg prune`

```text
ygg prune
ygg prune --apply [--yes]
```

`ygg prune` previews registrations whose worktree directory is missing and which Git considers
pruneable with `--expire now`. It does not change metadata.

`--apply` delegates cleanup to `git worktree prune --expire now`. A terminal asks for confirmation;
non-interactive application requires `--apply --yes`. `--yes` without `--apply` is invalid.

Pruning removes only stale Git administrative metadata. It never removes a directory or branch,
does not run project hooks, and preserves locked worktrees.

## `ygg config`

```text
ygg config
ygg config init [worktree] [--yes] [--force]
ygg config trust [--yes]
ygg config untrust [--yes]
```

`ygg config` prints normalized workspace YAML followed by absolute workspace, worktree, shared-file,
and project-configuration paths, the project behavior hash, and trust state.

| Command | Meaning |
| --- | --- |
| `config init` | Generate `.ygg.yml` from detected Node package conventions and guided choices. |
| `config init --yes` | Use detected defaults without prompting. |
| `config init --force` | Replace an existing `.ygg.yml`. |
| `config trust` | Review and trust the current/default project behavior until it changes. |
| `config untrust` | Remove locally recorded trust. |

Non-interactive trust and untrust require `--yes`. See [configuration](configuration.md) for the
complete schema and trust model.

## `ygg shell-init`

```text
ygg shell-init <bash|zsh|fish>
```

Prints the shell function and dynamic completion definitions used by `ygg cd` and `ygg create --cd`.

```sh
eval "$(ygg shell-init zsh)"
eval "$(ygg shell-init bash)"
ygg shell-init fish | source
```
