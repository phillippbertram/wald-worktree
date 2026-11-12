---
title: "Get started"
description: "Install wald, keep your existing checkout, and create your first worktree."
---

Create a worktree beside a project you already use. The existing checkout stays in place.

## Supported platforms

| Platform | Processor | Release archive |
| --- | --- | --- |
| macOS | Apple Silicon (ARM64) | `wald-darwin-arm64.tar.gz` |
| macOS | Intel (x64) | `wald-darwin-x64.tar.gz` |
| Linux (glibc) | ARM64 | `wald-linux-arm64.tar.gz` |
| Linux (glibc) | x64 | `wald-linux-x64.tar.gz` |

Release binaries are tested on macOS 15 and Ubuntu 24.04. wald needs Git 2.31.0 or newer.
The binary includes the Bun runtime.

## Install wald

```bash
curl -fsSL https://raw.githubusercontent.com/phillippbertram/wald-worktree/main/install.sh | bash
```

The installer selects the archive for your machine from the latest published release, verifies its
SHA-256 checksum, and installs or updates `~/.local/bin/wald`. Set `WALD_INSTALL_DIR` to an absolute
directory path in the Bash process to choose a different destination.

If `wald` is missing from your `PATH`, run the following in Bash or Zsh and add the export to your
shell startup file to use it in future sessions.

```sh
export PATH="$HOME/.local/bin:$PATH"
wald --version
```

### Install from a download

Download your archive and `SHA256SUMS` from the same [GitHub release](https://github.com/phillippbertram/wald-worktree/releases).
In the download directory, set `archive` to the file you selected and verify it. Use `shasum` on
macOS or `sha256sum -c` in place of `shasum -a 256 -c` on Linux.

```sh
archive=wald-darwin-arm64.tar.gz
awk -v archive="$archive" '$2 == archive' SHA256SUMS | shasum -a 256 -c
```

Once the checksum reports `OK`, extract and install the executable.

```sh
tar -xzf "$archive"
mkdir -p "$HOME/.local/bin"
install -m 755 wald "$HOME/.local/bin/wald"
"$HOME/.local/bin/wald" --version
```

## Keep the checkout you already have

```sh
cd ~/dev/canopy
wald init
```

Choose to retain the existing checkout. Check the proposed paths and confirm initialization.
wald keeps your primary checkout in place and proposes a separate directory for new worktrees.
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

The global `-C` option selects the starting directory for wald. From elsewhere, point it at the
primary checkout or another worktree in the workspace:

```sh
wald -C ~/dev/canopy status
wald -C ~/dev/canopy create feature/api
```

The terminal stays in its current directory. To navigate with `wald cd` or create with
`--cd`, load [shell integration](cli-reference.md#wald-completion).

Next, see [why worktrees help](worktrees.md), [prepare new checkouts](project-setup.md), or
[assign a worktree to each agent](agent-workflows.md).
