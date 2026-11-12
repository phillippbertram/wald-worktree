---
title: "Binary packaging prototype"
description: "Build and verify the experimental standalone executable."
---

Wald can be bundled with Bun into one executable. The destination machine needs Git 2.31.0 or
newer and the programs used by configured hooks or tools, but no separate Node.js, Bun,
`node_modules`, or source checkout. Shell navigation still requires the normal
[shell integration](cli-reference.md#wald-completion).

This is an experimental packaging path, not a published or signed release. The standard Node
installation remains supported. pnpm still owns dependency installation and the lockfile; Bun is
only an additional build tool. No production dependency was added or upgraded.

## Build

Use Node and pnpm as specified in `package.json`, and Bun **1.4.4**, pinned in `.bun-version`.
The build script rejects a different Bun version before building. `BUN_BINARY` can point to an
isolated Bun executable without replacing an existing installation.

The build disables Bun's automatic runtime loading of `.env`, `bunfig.toml`, `tsconfig.json` and
`package.json`. Repository-local Bun settings and preload scripts must not change Wald's behavior
or bypass its explicit configuration/trust model. Environment variables explicitly supplied by
the caller still reach hooks and tools normally.

```sh
pnpm install --frozen-lockfile
pnpm build:binary
./packages/cli/dist/binary/wald --version
```

The native executable is written to `packages/cli/dist/binary/wald`. Generated binaries remain ignored.
The build script runs in the CLI package. Additional arguments go directly to Bun, so relative
output paths resolve from `packages/cli/`:

```sh
pnpm build:binary --target=bun-linux-x64-baseline --outfile=dist/binary/wald-linux-x64
pnpm build:binary --target=bun-linux-arm64 --outfile=dist/binary/wald-linux-arm64
pnpm build:binary --target=bun-darwin-x64 --outfile=dist/binary/wald-darwin-x64
```

Cross-compilation is not runtime verification. Linux's default GNU target needs a compatible
system C library. This prototype does not establish support for every Linux distribution or
for Windows. See [Bun's compiler documentation](https://bun.sh/docs/compiler).

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

The `Binary prototype` GitHub Actions workflow runs for pull requests, pushes to `main`, and manual
dispatches. It builds native binaries on macOS and Ubuntu 24.04, runs both the binary integration suite
and isolated shell/PTY smoke suite, and uploads archives preserving executable permissions. These
checks execute the Linux binary on a Linux runner; they do not publish a release.
The Ubuntu runner is pinned so changes to the `ubuntu-latest` alias cannot silently change the
binary's build environment and system C library baseline.

## Local findings (2026-11-11)

Native verification used macOS ARM64 and Bun 1.4.4. The binary is approximately 86 MiB uncompressed.
The standalone runtime works with the current Commander, Clack, Execa, YAML, Zod and completion
dependencies. Runtime reporting in `wald doctor` identifies Bun instead of treating Bun's emulated
Node version as an installed Node runtime. File automation uses the `glob` package to keep explicit
dotfile patterns such as `**/.env*` working across runtimes, including Node 22.13.0, whose experimental
`fs.glob` misses these matches. The existing path validation and preflight checks still apply.

The binary integration suite also exercises dotfile copying and rejects source symlinks that
escape their configured root before writing any targets. The Node CI caps Vitest at two workers, and
multi-process integration suites that exceeded their previous limits allow 30 seconds per test.
Unit-test timeouts and all behavioral assertions remain unchanged.

The isolated smoke suite passed with Bash 5.3 and bash-completion 2.17.0, Zsh 5.9, and Fish 4.9.3.
It exercised all shell navigation checks, real Bash/Zsh Tab input, Fish completion, guided creation,
confirmation rejection, Escape, Ctrl+C, relocation without Node/Bun, and disabled configuration
autoloading. Shell tools were kept outside the repository; no user shell installation was changed.

Cross-compilation succeeded for macOS x64, Linux x64 baseline and Linux ARM64. Only macOS ARM64
was executed locally. Check the pull request's native CI results separately; cross-built artifacts
for architectures outside that matrix still need native tests.

Before distribution, run the native platform workflow, decide the supported architecture and Linux
libc matrix, and prepare release archives, checksums, dependency notices and macOS signing/notarization.
The portable `skills/` directory is not embedded; a release that distributes the agent skill must
include it separately. Startup performance and memory usage have not been benchmarked.
