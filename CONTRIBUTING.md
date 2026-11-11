# Contributing

Thanks for helping improve Wald.

## Development

Requirements:

- Node.js 22 or newer
- pnpm 11
- Git

Install dependencies and validate the project:

```sh
pnpm install
pnpm run ci
```

Run the CLI directly from source:

```sh
pnpm dev -- --help
```

Keep command handlers thin, keep Git and filesystem behavior outside the UI layer, and add
integration coverage for changes that affect repository state. Never commit real environment files
or secrets as fixtures. Keep product copy, visuals, and emoji consistent with the
[Wald brand identity](docs/brand.md).

## Continuous integration

Pull requests and pushes to `main` run five jobs:

| Job | Runtime | Validation |
| --- | --- | --- |
| Ubuntu 24.04 | Node 22.13.0 | `pnpm run ci`, built CLI help, and Bash/Zsh/Fish shell integration |
| macOS | Node 24 | `pnpm run ci` and built CLI help |
| Minimum Git on Ubuntu 24.04 | Node 22.13.0, Git 2.31.0 | `pnpm test:git` |
| Linux binary | Bun from `.bun-version` | Native build, binary integration tests, and isolated shell/PTY smoke tests |
| macOS binary | Bun from `.bun-version` | Native build, binary integration tests, and isolated shell/PTY smoke tests |

The two Node jobs cover both supported operating systems with Node 22.13.0 and Node 24.
The Ubuntu job reuses its installed dependencies and built CLI for the shell checks.

`pnpm test:git` runs every `tests/*.integration.test.ts` file plus
`tests/worktree-transfer-service.test.ts`, which also exercises real Git repositories. Add new
Git integration coverage using the `.integration.test.ts` suffix so the minimum-Git job includes it.
The full validation in both Node jobs includes all unit tests, lint, typecheck, and build.
See [Binary packaging](docs/binary-packaging.md) for standalone test requirements and artifacts.
