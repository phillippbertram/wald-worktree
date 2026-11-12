---
title: "Get started"
description: "Install Wald, keep your existing checkout, and create your first worktree."
---

Create a worktree beside a project you already use. The existing checkout stays in place.

## Supported platforms

| Platform | Wald CLI support | Standard CLI test environment |
| --- | --- | --- |
| macOS | Supported | macOS with Node.js 24 |
| Linux | Supported | Ubuntu 24.04 with Node.js 22.13.0 |
| Native Windows | Unsupported | — |

See [binary packaging](binary-packaging.md) for the experimental standalone executable and its
platform verification.

## Install Wald

The standard installation builds from source and requires Node.js 22.13.0 or newer,
Git 2.31.0 or newer, and pnpm 11.15.1.

```sh
git clone https://github.com/phillippbertram/wald-worktree.git
cd wald-worktree
pnpm install --frozen-lockfile
pnpm run install:global
wald --help
```

## Keep the checkout you already have

```sh
cd ~/dev/canopy
wald init
```

Choose to retain the existing checkout. Check the proposed paths and confirm initialization.
Wald keeps your primary checkout in place and proposes a separate directory for new worktrees.
The optional project-configuration step can wait until you need [project setup](project-setup.md).

Starting from a remote instead? See [workspace layouts](worktrees.md#workspace-layouts).

## Create a worktree

Run `wald` for the guided menu. Choose **Create worktree**, enter `feature/search`, and review
the plan. After creation, the result menu offers to open the worktree, show navigation commands,
return to the main menu, or exit.

Use direct commands when you already know what you want:

```sh
wald create feature/search
wald list
wald open feature-search --tool code
```

Use an installed editor or agent that fits your project. `wald list` shows the exact path
if you prefer to open the folder yourself.

## Work from any terminal

The global `-C` option selects the starting directory for Wald. From elsewhere, point it at the
primary checkout or another worktree in the workspace:

```sh
wald -C ~/dev/canopy status
wald -C ~/dev/canopy create feature/api
```

The terminal stays in its current directory. To navigate with `wald cd` or create with
`--cd`, load [shell integration](cli-reference.md#wald-completion).

Next, see [why worktrees help](worktrees.md), [prepare new checkouts](project-setup.md), or
[assign a worktree to each agent](agent-workflows.md).
