# worktree-cli

`wt` is a small workspace manager built on top of Git worktrees. It keeps the bare repository,
linked worktrees, and shared local environment files in one predictable workspace.

```text
my-project/
├── repo.git/
├── .wt/
│   ├── config.json
│   └── env/
├── main/
└── feature-payment/
```

The project is an early source-only MVP for macOS and Linux. It does not publish an npm package yet.

## Why

Plain Git worktrees are useful, but a daily workflow still involves choosing paths, resolving
branches, sharing ignored configuration, and checking that removal is safe. `wt` handles that
workspace-level coordination while leaving Git as the source of truth.

## Requirements

- Node.js 22 or newer
- pnpm 11
- Git

## Install from source

Clone this repository first, then run:

```sh
cd worktree-cli
pnpm install
pnpm run link:global
wt --help
```

Remove the global `wt` command again with:

```sh
pnpm run unlink:global
```

For development without a global link:

```sh
pnpm dev -- --help
```

## Quickstart

Create a workspace from a remote URL or local Git repository:

```sh
wt init git@github.com:example/project.git ~/dev/project
cd ~/dev/project
wt add main
wt add feature/payment
```

`wt add` fetches `origin` and resolves the branch in this order:

1. Check out an existing local branch.
2. Create a tracking branch for an existing remote branch.
3. Create a new branch from `origin/<default-branch>` or `--from`.

The default directory replaces branch separators, so `feature/payment` becomes `feature-payment`.
Use `--name` to override it.

## Commands

| Command | Purpose |
| --- | --- |
| `wt init <repository> [directory]` | Create a managed bare workspace. |
| `wt add <branch>` | Check out or create a branch in a sibling worktree. |
| `wt list` | Show branch, state, and path for every managed worktree. |
| `wt remove <worktree>` | Safely remove a worktree without deleting its branch. |
| `wt env import [worktree]` | Import ignored `.env*` files and replace them with shared links. |
| `wt env sync [worktree]` | Create missing shared environment links. |
| `wt env status [worktree]` | Show `linked`, `missing`, `conflict`, and `wrong-link` states. |

Run `wt <command> --help` for all options. `wt list --json` and `wt env status --json` provide
machine-readable output. Interactive prompts are only used when both stdin and stdout are terminals.

## Shared environment files

The shared store mirrors repository-relative paths:

```text
.wt/env/apps/api/.env
feature-payment/apps/api/.env -> ../../../.wt/env/apps/api/.env
```

Import only considers untracked files that Git already ignores. It excludes common vendor, build,
coverage, and fixture directories as well as `.example`, `.sample`, and `.template` files.

```sh
wt env import main
wt env status
wt env sync feature-payment
```

Before importing, `wt` shows paths but never file contents. Existing shared files with different
content are conflicts and are preserved. Synchronization never overwrites regular files. Incorrect
symlinks are only replaced with `wt env sync --repair`.

> [!WARNING]
> `.wt/env` contains plaintext secrets outside Git. Protect the workspace directory, keep backups as
> appropriate for your environment, and never publish it.

## Removal safety

`wt remove` refuses to remove a worktree when it is dirty, its branch is not merged into the known
default branch, or the worktree is locked. Interactive removal requires confirmation. Non-interactive
removal requires `--force`.

`--force` can discard worktree files. It still does not delete the Git branch or `.wt/env`.

## Architecture

```text
Commander + Ink
       │
       ▼
Workspace / Worktree / Environment services
       │
       ▼
Git CLI + filesystem
```

Command parsing and terminal rendering are adapters. Workspace rules are independent of Commander
and Ink, while all repository operations go through the installed Git CLI. Worktree discovery uses
`git worktree list --porcelain -z`; no derived worktree registry is maintained.

## Troubleshooting

### No managed workspace found

Run the command from the workspace root or anywhere inside one of its worktrees. A managed workspace
is identified by `.wt/config.json`.

### A branch is already checked out

Git only allows one normal checkout of a branch at a time. Use `wt list` to find its existing path or
create a different branch.

### Environment conflict preserved

A real file or unexpected symlink already exists at the target. Compare it manually. `--repair`
replaces wrong symlinks only; it intentionally never replaces a regular file.

### Offline branch creation

`wt add` fetches by default. Use `wt add <branch> --no-fetch` to work with the refs already available
in `repo.git`.

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [SECURITY.md](SECURITY.md) for
private vulnerability reporting. Planned follow-up features are tracked in the
[roadmap](docs/roadmap.md).

## License

[MIT](LICENSE)
