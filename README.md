# worktree-cli

`wt` creates and prepares isolated Git worktrees for parallel development, editors, and coding
agents. Git remains the source of truth; `wt` adds predictable paths, project setup, navigation, and
safe removal.

## Mental model

There are four separate pieces:

- A **workspace** connects one Git repository to `wt` and stores local metadata.
- A **worktree** is an isolated checkout for one branch.
- An optional committed **`.wt.yml`** defines setup steps, named tasks, and tool profiles.
- Optional **shell integration** lets `wt cd` and `wt create --cd` change the current terminal.

You can keep an existing checkout or start from a remote repository:

| Starting point | Command | Result |
| --- | --- | --- |
| Existing checkout | `wt init` | Keeps the checkout in place and creates sibling worktrees. |
| Remote or local repository | `wt init <repository> [directory]` | Creates a dedicated workspace backed by a bare clone. |

The existing checkout is the primary worktree and can never be removed by `wt`. A managed
workspace instead starts without a checkout and creates its first one with `wt create`.

## Requirements and source installation

- Node.js 22.13 or newer
- pnpm 11
- Git

The CLI is not published to npm yet. Install it from this repository:

```sh
git clone git@github.com:phillippbertram/worktree-cli.git
cd worktree-cli
pnpm install
pnpm run link:global
wt --help
```

Remove the global link with `pnpm run unlink:global`. For development without a global link, use
`pnpm dev -- --help`.

## Shell integration

Enable navigation and dynamic completion in the current shell:

```sh
# zsh
eval "$(wt shell-init zsh)"

# bash
eval "$(wt shell-init bash)"

# fish
wt shell-init fish | source
```

Add the matching line to `~/.zshrc`, `~/.bashrc`, or `~/.config/fish/config.fish` to enable it in
future terminals. Without the wrapper, `wt cd` prints the path and `wt create --cd` prints a normal
`cd <path>` fallback.

## Start with an existing repository

```sh
cd ~/dev/project
wt init
wt create feature/payment --cd
```

`wt init` inspects the repository, asks where new worktrees should live, and leaves the existing Git
configuration and working tree unchanged. Creating `.wt.yml` during initialization is optional; if
you create it, review and commit it before expecting it to configure other worktrees.

Open a new worktree directly in an editor or agent instead of entering it:

```sh
wt create feature/payment --tool code
wt create feature/review --tool codex
```

`--cd` and `--tool`/`--open` are alternative destinations and cannot be combined.

## Start from a remote repository

```sh
wt init git@github.com:example/project.git ~/dev/project
cd ~/dev/project
wt create main --cd
```

The initialized directory contains local workspace metadata, the bare repository, and sibling
worktrees such as `main/` and `feature-payment/`. `wt init` prints the required `cd` and first-create
commands after cloning.

## What “start” means

There is intentionally no ambiguous `wt start` command:

| Goal | Command |
| --- | --- |
| Create and enter a terminal worktree | `wt create <branch> --cd` |
| Create and open an editor or agent | `wt create <branch> --tool <profile>` |
| Enter an existing worktree | `wt cd <worktree>` |
| Open an existing worktree | `wt open <worktree> --tool <profile>` |
| Start a configured development process | `wt run dev <worktree>` |

Run `wt` without arguments for a guided menu. Direct commands remain deterministic for scripts and
agents.

## Project setup and tasks

Generate an optional repository-owned configuration from detected Node package conventions:

```sh
wt config init
git diff -- .wt.yml
git add .wt.yml
git commit -m "chore: configure worktree setup"
wt config trust
```

The wizard detects npm, pnpm, Yarn, or Bun, an environment example, common verification scripts,
and an exact `dev` package script. It keeps the long-running `dev` task separate from the one-shot
`verify` task. Other ecosystems can use manually defined commands; automatic Flutter, iOS, and Rust
detection is not part of v1.

A small example:

```yaml
version: 1

hooks:
  post_create:
    - type: command
      argv: [pnpm, install, --frozen-lockfile]
    - type: copy
      source: default
      from: .env.example
      to: .env
      optional: true

tasks:
  verify:
    steps:
      - type: command
        argv: [pnpm, lint]
      - type: command
        argv: [pnpm, test]
  dev:
    steps:
      - type: command
        argv: [pnpm, dev]
```

Run tasks in the current, only, selected, or explicitly named worktree:

```sh
wt run verify feature-payment
wt run dev feature-payment
```

Hooks, tasks, and custom tools execute code. `wt` therefore requires trust in their normalized
behavior. Formatting-only YAML changes preserve trust; changed commands or actions require a new
decision. See [configuration](docs/configuration.md) for the complete schema, lifecycle, local-file
copy/symlink patterns, and trust model.

## Common development workflows

### Existing, remote, and new branches

```sh
wt create release/1.x
wt create feature/already-on-origin
wt create feature/new-work
```

After the configured fetch, `wt create` uses a local branch, tracks an existing remote branch, or
creates a new branch from the configured default branch. Branch separators become hyphens in the
directory name. If two branch names produce the same directory, choose one explicitly:

```sh
wt create feature/a-b --name feature-a-b-2
```

### Hotfixes and stacked work

```sh
wt create hotfix/payment --from release/1.x --cd

cd ../feature-base
wt create feature/stacked --from HEAD --cd
```

An explicit `--from HEAD` uses the current worktree's commit. Without `--from`, new branches always
start from the configured default branch.

### Editors and coding agents

```sh
wt open feature-payment --tool cursor
wt create feature/review --tool codex
```

Built-in profiles are `code`, `cursor`, `zed`, `codex`, `codex-app`, and `claude`. Custom profiles
live in `.wt.yml`; unavailable tools are omitted from interactive selection. See
[agent workflows](docs/agent-workflows.md) for the packaged Agent Skill and agent-specific flow.

### Recover failed setup

If a `post_create` step fails, the worktree is intentionally kept:

```sh
wt setup feature-payment
```

Fix the reported cause and use the printed command to retry the configured setup.

### Local files and shared directories

Use explicit `copy` or `symlink` steps in `.wt.yml` to prepare ignored files and shared local
directories. Sources can be the current, default, or primary worktree. `wt` never scans or migrates
secret files implicitly.

### Safe cleanup

```sh
wt remove feature-payment
wt remove feature-payment --yes
```

Removal refuses dirty, unmerged, and locked worktrees unless `--force` is explicit. The Git branch
is always preserved. Non-interactive removal additionally requires `--yes`.

### Repository without a remote

```sh
wt init --adopt . --no-remote --default-branch main --yes
```

New branches then resolve exclusively from local refs.

## Commands

### Core worktree flow

| Command | Purpose |
| --- | --- |
| `wt init` | Set up the current repository. |
| `wt init <repository> [directory]` | Clone into a managed workspace. |
| `wt create [branch]` | Create and prepare a worktree. |
| `wt list [--json]` | Show branch, role, status, and path. |
| `wt cd [worktree]` | Enter a worktree or print its path. |
| `wt open [worktree] --tool <profile>` | Open an editor, app, or agent. |
| `wt remove [worktrees...]` | Safely remove worktrees while preserving branches. |

### Project automation

| Command | Purpose |
| --- | --- |
| `wt config init [worktree]` | Generate a detected `.wt.yml`. |
| `wt config` | Show and validate workspace/project configuration. |
| `wt config trust\|untrust` | Manage executable configuration trust. |
| `wt setup [worktree]` | Re-run `.wt.yml` `post_create` steps. |
| `wt run [task] [worktree]` | Run a named `.wt.yml` task. |
| `wt exec [worktree] -- <command>` | Run an argument-safe ad-hoc command. |
| `wt shell-init bash\|zsh\|fish` | Print navigation and completion integration. |

Use `wt <command> --help` for all options. JSON is available for data interfaces such as
`wt list --json`; configuration is YAML-only.

## Troubleshooting

### `wt cd` only prints a path

Load the matching `wt shell-init` output. A child process cannot change its parent shell without the
wrapper.

### Project configuration is not trusted

Review `.wt.yml`, run `wt config`, and then approve it with `wt config trust`. Non-interactive use
requires `wt config trust --yes`.

### A branch is already checked out

Git allows a normal branch in only one worktree. Run `wt list` and enter or open the existing
worktree instead.

### Post-create setup failed

The checkout remains available. Fix the cause and run the printed `wt setup <worktree>` command.

### No managed workspace found

Run the command from the adopted checkout, a linked worktree, or the dedicated workspace root. Use
`wt init` once if the repository has not been connected yet.

## Safety and roadmap

`wt remove` never deletes branches, and the primary checkout of an adopted repository is protected.
Executable project behavior requires semantic trust. The next standalone command is `wt doctor`,
followed by preview-first `wt prune`. Stable port offsets and Compose project identities remain the
next major parallel-development capability after operational diagnostics.

See [the roadmap](docs/roadmap.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[SECURITY.md](SECURITY.md).

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

[MIT](LICENSE)
