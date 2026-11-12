# Contributing

## Development

Use Node.js 22.13.0 or newer, Git 2.31.0 or newer, and pnpm 11.15.1. The docs checks and demo recorder
require Python 3.

```sh
pnpm install --frozen-lockfile
pnpm dev --help
pnpm run ci
```

The pnpm workspace contains the [CLI package](packages/cli/) and the
[documentation app](apps/docs/). Commands in the root package delegate to them.
The portable [agent skill](skills/wald-worktrees/) remains at the repository root and is
included when packaging the CLI.

Keep command handlers thin and put Git and filesystem behavior outside the UI layer. Add
integration coverage for changes that affect repository state. Use disposable repositories and
synthetic files in tests. Follow the [brand guidelines](docs/brand.md) for product copy and visuals.

## Continuous integration

| Job | Runtime | Validation |
| --- | --- | --- |
| Ubuntu 24.04 | Node 22.13.0 | CLI lint, typecheck, tests, build, and Bash/Zsh/Fish integration |
| macOS | Node 24 | CLI lint, typecheck, tests, and build |
| Minimum Git on Ubuntu 24.04 | Node 22.13.0, Git 2.31.0 | Git integration tests |
| Linux and macOS binary | Bun from .bun-version | Native build, integration tests, and isolated PTY checks |
| Docs on Ubuntu 24.04 | Node 24 and Python 3 | Demo transcripts, static export, links, and browser tests |

Run `pnpm ci:cli` for CLI checks alone. `pnpm test:git` runs the CLI integration tests and
worktree-transfer tests. Use the `.integration.test.ts` suffix for new Git integration
coverage so the minimum-Git job includes it. See [Binary packaging](docs/binary-packaging.md)
for standalone test requirements.

## Work on the docs

Edit the canonical Markdown and MDX in [docs/](docs/) and run `pnpm docs:dev`. The local
site uses the same `/wald-worktree/` prefix as GitHub Pages.

See [the docs app guide](apps/docs/README.md) for demo recording, browser checks, and deployment.
