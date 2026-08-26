# worktree-cli

`wt` creates and prepares isolated Git worktrees for parallel development, editors, and coding
agents. Git remains the source of truth; `wt` adds predictable paths, project setup, navigation, and
safe removal.

## Mental model

There are four separate pieces:

- A **workspace root** connects one Git repository to `wt` and contains or points to its worktrees.
- A **worktree** is an isolated checkout for one branch.
- An optional committed **`.wt.yml`** defines setup steps, named tasks, and tool profiles.
- Optional **shell integration** lets `wt cd` and `wt create --cd` change the current terminal.

Configuration and local files deliberately have different owners:

| Location | Owner | Purpose |
| --- | --- | --- |
| `.wt/workspace.yml` | Local workspace | Git, worktree, remote, and default-branch paths. |
| `.wt/shared/` | Local workspace | Secrets and shared local files used by setup steps. |
| `.wt.yml` | Git repository | Committed setup, tasks, and editor/agent profiles. |

`wt init` presents two user-facing choices in an existing repository: keep the current checkout or
create a new standalone workspace root. The internal `managed`/`adopted` distinction is only needed
for path validation and protection of an original checkout.

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

## Choose a workspace layout

### Recommended: one standalone root

For new setups, keep the bare repository, local metadata, shared files, and all worktrees together:

```text
project/
├── .wt/
│   ├── workspace.yml
│   └── shared/
├── repo.git/
├── main/
├── feature-payment/
└── feature-review/
```

Create this layout from a remote or local repository:

```sh
wt init git@github.com:example/project.git ~/dev/project
cd ~/dev/project
wt create main --cd
```

Run `wt init` without arguments for the full wizard; it can create the `main` worktree immediately.

### Group worktrees below a subdirectory

If the workspace root should contain only infrastructure directories, choose a worktree directory:

```sh
wt init git@github.com:example/project.git ~/dev/project --worktrees-dir worktrees
```

```text
project/
├── .wt/
├── repo.git/
└── worktrees/
    ├── main/
    └── feature-payment/
```

For a standalone workspace, the worktree directory must stay inside its root. `.wt` and `repo.git`
remain fixed so workspace discovery and deletion checks stay predictable.

### Keep an existing checkout

The quickest option leaves the checkout where it is and uses a separate worktree container:

```text
dev/
├── project/                    # existing protected checkout
└── project-worktrees/
    ├── .wt -> ../project/.git/wt
    ├── feature-payment/
    └── feature-review/
```

Choose the container interactively or explicitly:

```sh
cd ~/dev/project
wt init --adopt . --worktrees-dir ../project-worktrees --yes
```

The existing checkout remains the protected primary worktree and can never be removed by `wt`.

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
```

The wizard inspects remotes, branches, changes, stashes, and existing worktrees, then offers:

- **Keep this checkout:** configure a separate worktree directory without changing the checkout.
- **Create a new workspace root:** copy committed branches and tags into the recommended bare layout.

The second option also works without a remote. It never moves or deletes the original checkout.
Uncommitted and ignored files, changes in linked worktrees, stashes, detached commits,
repository-local hooks, and checkout-local Git settings remain only in the original and are shown
or called out in the confirmation summary. Put detached commits on a branch before copying if they
must be available in the new workspace. Keep the original until the new workspace has been
verified; archive or remove it manually later.

With an existing checkout kept in place, create a feature directly:

```sh
wt create feature/payment --cd
```

For a new standalone root, the wizard normally creates the default worktree and prints its exact
`cd` command. Creating `.wt.yml` during initialization is optional; review and commit it before
expecting it to configure later worktrees.

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

The initialized directory contains local workspace metadata, `.wt/shared`, the bare repository,
and sibling worktrees such as `main/` and `feature-payment/`. The direct command prints the required
`cd` and first-create commands. Running `wt` or interactive `wt init` provides the complete wizard
and can create the default worktree immediately.

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

`default_branch` is the stable workspace reference used for three decisions: the base of new
branches when `--from` is omitted, the merge target used by safe removal checks, and the preferred
branch/worktree for `.wt.yml` plus `source: default`. It does not switch an existing branch and does
not override an explicit `--from`.

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

Each workspace has a local `.wt/shared` directory. `wt config` prints its absolute `shared_path`,
which is useful when an existing checkout stores the metadata inside its Git directory.

Use `source: shared` in a trusted `.wt.yml` to link centrally maintained files into every new
worktree. A monorepo can preserve repository-relative paths:

```text
.wt/shared/env/
├── .env
├── apps/api/.env
└── apps/web/.env.local
```

```yaml
hooks:
  post_create:
    - type: symlink
      source: shared
      from: env/.env
      to: .env

    - type: symlink
      source: shared
      from: env/apps/api/.env
      to: apps/api/.env

    - type: symlink
      source: shared
      from: env/apps/web/.env.local
      to: apps/web/.env.local
```

Generated links are relative, so editing the central file is immediately visible in every
worktree. Use `copy` instead when each worktree should receive an independent snapshot. A copied
file only changes when its task or `wt setup` runs again; use `overwrite: true` only when replacing
the target is intentional.

`wt` never scans, moves, or imports secrets automatically. Populate `.wt/shared` manually, restrict
secret files to the owning user (for example mode `600`), and keep the repository paths stable for
other developers. The shared directory itself is created with mode `700` and is never committed.
For an existing `.env`, copy it into the displayed shared path, verify it, rename the original to a
backup, and then run `wt setup <worktree>`. Without `overwrite: true`, an existing target blocks the
step instead of being silently replaced.

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
| `wt init` | Choose between keeping the checkout and creating a standalone workspace root. |
| `wt init <repository> [directory]` | Clone a remote or local repository into a standalone root. |
| `wt create [branch]` | Create and prepare a worktree. |
| `wt list [--json]` | Show branch, role, status, and path. |
| `wt cd [worktree]` | Enter a worktree or print its path. |
| `wt open [worktree] --tool <profile>` | Open an editor, app, or agent. |
| `wt remove [worktrees...]` | Safely remove worktrees while preserving branches. |

### Project automation

| Command | Purpose |
| --- | --- |
| `wt config init [worktree]` | Generate a detected `.wt.yml`. |
| `wt config` | Show configuration plus absolute workspace, worktree, and shared paths. |
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

### No wt workspace found

Run the command from the retained checkout, a linked worktree, or the standalone workspace root. Use
`wt init` once if the repository has not been connected yet.

## Safety and roadmap

`wt remove` never deletes branches, and a retained primary checkout is protected.
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
