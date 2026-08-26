# worktree-cli

`wt` turns Git worktrees into predictable development environments. Keep a feature, a hotfix, a
review, and a coding agent open at the same time without cloning the repository again or constantly
switching one checkout back and forth.

Git remains the source of truth. `wt` adds stable paths, branch resolution, repeatable setup,
navigation, editor and agent launching, trusted project tasks, and safe cleanup.

## Why worktrees?

A Git branch names a line of development, but a normal checkout still shows only one branch at a
time. Switching branches replaces the files in that directory. An urgent fix therefore often means
stashing unfinished work, stopping processes, switching dependencies, and later rebuilding the
previous context.

[Git worktrees](https://git-scm.com/docs/git-worktree) attach multiple working directories to one
repository. They share Git history and refs, while each worktree has its own checked-out files,
`HEAD`, and index. That makes workflows possible that branching alone does not provide in one
checkout:

- keep unfinished feature files untouched while fixing production;
- compare or test two branches side by side;
- run separate development processes without repeatedly switching files;
- give each editor or coding agent an isolated checkout;
- review a remote branch while continuing work elsewhere.

The [Git branching introduction](https://git-scm.com/book/en/v2/Git-Branching-Branches-in-a-Nutshell)
explains branches themselves. Worktrees complement them; they do not replace them.

Native `git worktree` commands provide the foundation. `wt` handles the repeated policy around
them: where checkouts live, whether a branch is local or remote, which setup runs, how local files
arrive, which tool opens, and whether cleanup is safe.

## Quick start

Requirements: Node.js 22.13 or newer, pnpm 11, and Git.

The CLI is not published to npm yet. Install it from this repository:

```sh
git clone git@github.com:phillippbertram/worktree-cli.git
cd worktree-cli
pnpm install
pnpm run link:global
wt --help
```

Create a standalone workspace from a remote repository:

```sh
wt init git@github.com:example/project.git ~/dev/project
cd ~/dev/project
wt create main --cd
wt create feature/payment --tool code
```

The default layout keeps one shared Git repository and multiple independent checkouts together:

```text
project/
├── .wt/
│   ├── workspace.yml
│   └── shared/
├── repo.git/
├── main/
└── feature-payment/
```

Already have a checkout? Run the guided setup from it:

```sh
cd ~/dev/project
wt init
```

Choose whether to keep that checkout and place new worktrees beside it, or create a new standalone
workspace from its committed history. The original checkout is never moved or deleted. Run `wt`
without arguments whenever you prefer the guided menu.

## Shell integration

Shell integration lets `wt cd` and `wt create --cd` change the current terminal:

```sh
# zsh
eval "$(wt shell-init zsh)"

# bash
eval "$(wt shell-init bash)"

# fish
wt shell-init fish | source
```

Add the matching line to your shell configuration to enable it in future terminals. Without the
wrapper, `wt cd` prints the canonical path and `wt create --cd` prints a normal `cd` fallback.

## Everyday development flows

### Fix production without disturbing a feature

Keep the current feature checkout, processes, and uncommitted files exactly as they are:

```sh
# In the existing feature worktree
wt create hotfix/payment --from release/1.x --tool code

# After the hotfix is merged
wt remove hotfix-payment
```

The hotfix has its own directory and dependencies. Removal checks for dirty files, an unmerged
branch, and locks before deleting the worktree directory. The branch itself is preserved.

### Review a remote branch beside your own work

```sh
wt create contributor/payment-fix --tool code
wt run verify contributor-payment-fix
wt remove contributor-payment-fix
```

After fetching, `wt create` reuses a local branch, tracks a matching remote branch, or creates a new
branch from the configured default branch. Branch separators become hyphens in directory names, so
`contributor/payment-fix` becomes `contributor-payment-fix`.

### Give parallel agents separate checkouts

```sh
wt create feature/api --tool codex
wt create feature/ui --tool codex-app
wt list
```

Built-in profiles cover Code, Cursor, Zed, Codex, Codex App, and Claude. A repository can define
additional profiles in `.wt.yml`. Each agent receives a real Git checkout instead of sharing staged,
unstaged, and generated files with another task.

### Start stacked work from the current commit

```sh
cd ~/dev/project/feature-base
wt create feature/follow-up --from HEAD --cd
```

An explicit `--from HEAD` resolves the commit of the worktree from which the command is run. Without
`--from`, a new branch always starts from the workspace's configured default branch.

### Prepare every worktree the same way

Commit a `.wt.yml` so every developer gets the same install and task flow while local secrets stay
outside Git:

```yaml
version: 1

hooks:
  post_create:
    - type: command
      argv: [pnpm, install, --frozen-lockfile]
    - type: symlink
      source: shared
      from: env
      glob: "**/.env*"
      to: .

tasks:
  verify:
    description: Run checks before review
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

Place centrally maintained files below `.wt/shared/env` using repository-relative paths:

```text
.wt/shared/env/
├── .env
├── apps/api/.env
└── apps/web/.env.local
```

The single glob step creates `.env`, `apps/api/.env`, and `apps/web/.env.local` in each target
worktree. `symlink` keeps them connected to the shared files; use `copy` for independent snapshots.

Create and review the project configuration before trusting it:

```sh
wt config init
git diff -- .wt.yml
git add .wt.yml
git commit -m "chore: configure worktree setup"
wt config trust
```

Hooks, tasks, file steps, and custom tools are executable behavior. Formatting-only YAML changes
preserve trust; behavioral changes require a new approval. If `post_create` fails, the new checkout
is kept so setup can be retried:

```sh
wt setup feature-payment
```

### Remove worktrees and prune stale metadata

These commands solve different cleanup problems:

| Goal | Command | What it removes |
| --- | --- | --- |
| Finish with an existing worktree | `wt remove feature-payment` | The checked-out directory, never the branch. |
| Inspect metadata for a directory deleted outside Git | `wt prune` | Nothing; this is a preview. |
| Apply that metadata cleanup | `wt prune --apply` | Only stale Git worktree registrations. |

Scripts must confirm destructive actions explicitly:

```sh
wt remove feature-payment --yes
wt prune --apply --yes
```

`wt prune` never deletes a directory or branch. Locked registrations are preserved.

## Configuration model

Configuration and local files have separate owners:

| Location | Owner | Purpose |
| --- | --- | --- |
| `.wt/workspace.yml` | Local workspace | Git, worktree, remote, default-branch, and trust state. |
| `.wt/shared/` | Local workspace | Secrets and shared local files used by trusted setup steps. |
| `.wt.yml` | Git repository | Committed hooks, tasks, file steps, and tool profiles. |

Use `wt config` to print the resolved workspace, worktree, shared-file, and project-configuration
paths.

## Documentation

- [CLI reference](docs/cli-reference.md): every command, argument, option, and non-interactive rule.
- [Configuration](docs/configuration.md): complete YAML schema, trust model, hooks, tasks, files, and
  tools.
- [Agent workflows](docs/agent-workflows.md): using isolated worktrees with coding agents.
- [Roadmap](docs/roadmap.md): intentionally deferred capabilities.

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Remove the global source link with `pnpm run unlink:global`. For development without a global link,
use `pnpm dev -- --help`.

## License

[MIT](LICENSE)
