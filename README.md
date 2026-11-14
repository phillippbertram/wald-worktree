# 🌲 wald — Git Worktrees CLI

[![CI](https://github.com/phillippbertram/wald-worktree/actions/workflows/ci.yml/badge.svg)](https://github.com/phillippbertram/wald-worktree/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1F4D3A.svg)](LICENSE)
[![Platforms: macOS and Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-6B4F3A.svg)](docs/getting-started.md)

**Git worktrees, ready for real work.**

Keep an unfinished feature open while you fix a bug, review a branch, or give a coding agent its
own working directory. wald creates the worktree and opens it in your editor or agent. Trusted
lifecycle hooks can install dependencies, copy local settings, and run project checks as you
create or retire a checkout. [Project setup and hooks](docs/project-setup.md)

The name comes from the German *Wald* (/valt/), meaning “forest”. [Why wald?](docs/index.md#why-wald)

[Website and interactive demos](https://phillippbertram.github.io/wald-worktree/) ·
[Quickstart](docs/getting-started.md) · [CLI reference](docs/cli-reference.md)

![Independent Git worktrees growing from one shared repository.](docs/assets/wald-worktrees.png)

## Get started

wald runs on macOS and Linux with Git 2.31.0 or newer.

```bash
curl -fsSL https://raw.githubusercontent.com/phillippbertram/wald-worktree/main/install.sh | bash
```

The installer verifies the release archive and puts `wald` in `~/.local/bin`. For manual
installation, get the matching archive and checksums from [GitHub Releases](https://github.com/phillippbertram/wald-worktree/releases).
See the [Quickstart](docs/getting-started.md#install-wald) for verification and `PATH` setup.

```sh
wald --help
```

In a project you already use, run `wald init` and choose to retain the existing checkout.
Then run `wald` for the guided menu, or create a worktree directly:

```sh
wald create feature/search
wald list
wald open feature-search --tool code
```

Use `wald -C ~/dev/canopy status` to inspect a workspace from elsewhere. Once you have
reviewed and trusted its [project setup](docs/project-setup.md), a single
`wald create feature/search --tool code` can create, prepare, and open the checkout.

## Learn more

- [Why worktrees?](docs/worktrees.md) — fix a bug beside an unfinished feature, or review a branch.
- [Parallel coding agents](docs/agent-workflows.md) — give each task separate files and staging.
- [Hand off and finish work](docs/finish.md) — copy local code or retire a checkout safely.
- [Configuration](docs/configuration.md) — hooks, tasks, tool profiles, and trust.
- [Agent skill](skills/wald-worktrees/SKILL.md) — portable operating instructions for agents.

## Contributing

See [Contributing](CONTRIBUTING.md) for the pnpm workspace, CLI checks, and local docs preview.

<a href="https://buymeacoffee.com/phillippbertram">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" width="180">
</a>

[MIT License](LICENSE)
