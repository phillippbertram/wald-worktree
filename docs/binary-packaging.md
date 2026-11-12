---
title: "Binary packaging"
description: "Build, verify, and prepare standalone wald binaries for GitHub Releases."
---

wald release archives contain a standalone executable built with Bun. To install a released
binary, follow the [Quickstart](getting-started.md#install-wald). Build dependencies are managed by
pnpm, and Bun compiles the executable.

## Build

Use Node and pnpm as specified in `package.json`, and Bun **1.4.4**, pinned in `.bun-version`.
The build script rejects a different Bun version before building. `BUN_BINARY` can point to an
isolated Bun executable without replacing an existing installation.

The build disables Bun's automatic runtime loading of `.env`, `bunfig.toml`, `tsconfig.json` and
`package.json`. Repository-local Bun settings and preload scripts must not change wald's behavior
or bypass its explicit configuration/trust model. Environment variables explicitly supplied by
the caller still reach hooks and tools normally.

```sh
pnpm install --frozen-lockfile
pnpm build:binary
./apps/cli/dist/binary/wald --version
```

The native executable is written to `apps/cli/dist/binary/wald`. Generated binaries remain ignored.
The build script runs in the CLI package. Additional arguments go directly to Bun, so relative
output paths resolve from `apps/cli/`:

```sh
pnpm build:binary --target=bun-linux-x64-baseline --outfile=dist/binary/wald-linux-x64
pnpm build:binary --target=bun-linux-arm64 --outfile=dist/binary/wald-linux-arm64
pnpm build:binary --target=bun-darwin-x64 --outfile=dist/binary/wald-darwin-x64
```

Run verification on the target platform after cross-compiling. Linux release builds use glibc.
See [Bun's compiler documentation](https://bun.sh/docs/compiler).

## Verification

```sh
pnpm run ci
pnpm build:binary
pnpm test:binary
pnpm test:binary:smoke
```

`test:binary` runs the existing CLI, JSON, completion, status, project configuration, skipped-hook,
and help subprocess contracts against the binary. In-process assertions still use the TypeScript
source; Vitest and some fixture hooks still use Node. To test an
executable at a different location, set an absolute `WALD_TEST_BINARY` path and invoke Vitest
directly. Without that variable, the same tests continue to run TypeScript through Node and tsx.

`test:binary:smoke` uses Python 3's standard library and requires Bash, Zsh and Fish. Set
`BASH_BINARY`, `ZSH_BINARY` or `FISH_BINARY` to use shells outside the current `PATH`. Set
`BASH_COMPLETION_FILE` to the installed `bash_completion` file to additionally exercise actual Bash
Tab input. Use Bash 4 or newer: Apple's Bash 3.2 lacks `compopt`, which the generated completion
uses. This is an existing shell compatibility limitation, independent of Bun. Without the file, the
smoke test explicitly reports that only registration and the completion protocol were checked
for Bash.

The smoke test copies only the binary to a temporary directory, creates a temporary home and Git
repositories, and supplies a restricted `PATH` containing Git, shells and selected system tools.
It asserts that neither Node nor Bun is discoverable. It then verifies:

- Relocated execution, help, version, non-TTY behavior and Git workspace creation.
- Doctor reporting the actual Bun runtime.
- Repository-local `.env` and Bun preload configuration having no runtime effect.
- Real PTY keypresses for menu selection, branch selection, text input, confirmation and creation.
- Declined creation preserving both the directory and branch state, Escape, and Ctrl+C exit 130.
- Bash, Zsh and Fish integration: completion registration/protocol, `cd`, `plant --cd`,
  `handoff --cd`, and preserving the current directory after a rejected `cd`.
- Fish completion through `complete -C`, and actual Zsh and Bash Tab input (Bash when configured).

It does not edit user shell profiles or global Git configuration. Its temporary files are removed
after the run, including on failure.

The **Release binaries** workflow tests Linux x64 and macOS ARM64 on pull requests and
pushes to `main`. Manual runs and version-tag pushes also test Linux ARM64 and macOS Intel. Each
runner tests the native executable and runs `scripts/test-release.py` against its own archive with
simulated GitHub downloads.

## Prepare a release

1. Update the CLI package and `wald --version` to the same version. Run **Release binaries** manually
   on the branch to produce the `wald-release-assets` Actions artifact with four native archives and
   `SHA256SUMS`.
2. After merging, create an annotated `vX.Y.Z` tag on the release commit and push that tag. For
   version `0.14.0`, use `git tag -a v0.14.0 -m 'wald 0.14.0'` and `git push origin v0.14.0`.
   The tag workflow verifies the version and prepares a GitHub Release draft after all builds and
   tests pass.
3. Review the generated notes, the four archives, and `SHA256SUMS` in
   [GitHub Releases](https://github.com/phillippbertram/wald-worktree/releases). Review dependency
   notices for the bundled runtime and packages before publishing. Publish the draft when it is
   ready for public downloads and the installer.

If an upload leaves an incomplete draft, confirm its status in GitHub Releases, delete the draft
while keeping the tag, and rerun the failed workflow job. The workflow stops if a release already
exists for that tag.
