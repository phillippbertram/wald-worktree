# 🌲 Wald — Git Worktrees CLI

[![CI](https://github.com/phillippbertram/wald-worktree/actions/workflows/ci.yml/badge.svg)](https://github.com/phillippbertram/wald-worktree/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1F4D3A.svg)](LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/Node.js-%3E%3D22.13-5F7D4E.svg)](package.json)
[![Platforms: macOS and Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-6B4F3A.svg)](docs/getting-started.md)

**Git worktrees, ready for real work.**

Keep an unfinished feature open while you fix a bug, review a branch, or give a coding agent its
own working directory. Wald creates Git worktrees, runs the project setup you approve, and opens
each checkout in the right tool.

[Website and interactive demos](https://phillippbertram.github.io/wald-worktree/) ·
[Quickstart](docs/getting-started.md) · [CLI reference](docs/cli-reference.md)

![Independent Git worktrees growing from one shared repository.](docs/assets/wald-worktrees.png)

## Get started

Use macOS or Linux, Node.js 22.13.0 or newer, Git 2.31.0 or newer, and pnpm 11.15.1.

```sh
git clone https://github.com/phillippbertram/wald-worktree.git
cd wald-worktree
pnpm install --frozen-lockfile
pnpm run install:global
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

The [standalone binary prototype](docs/binary-packaging.md) is available as an experimental
build path.

## Learn more

- [Why worktrees?](docs/worktrees.md) — fix a bug beside an unfinished feature, or review a branch.
- [Parallel coding agents](docs/agent-workflows.md) — give each task separate files and staging.
- [Hand off and finish work](docs/finish.md) — copy local code or retire a checkout safely.
- [Configuration](docs/configuration.md) — hooks, tasks, tool profiles, and trust.
- [Agent skill](skills/wald-worktrees/SKILL.md) — portable operating instructions for agents.

## Contributing

See [Contributing](CONTRIBUTING.md) for the pnpm workspace, CLI checks, and local docs preview.

If Wald saves you a few stashes or context switches, you can also
[buy me a coffee](https://www.buymeacoffee.com/phillippbertram).

[MIT License](LICENSE)
