# Contributing

## Development

Use Node.js 22.13.0 or newer, Git 2.31.0 or newer, and pnpm 11.15.1.

```sh
pnpm install --frozen-lockfile
pnpm dev --help
pnpm run ci
```

The pnpm workspace contains the [CLI package](apps/cli/) and the
[documentation app](apps/docs/). Commands in the root package delegate to them.
The portable [agent skill](skills/wald-worktrees/) remains at the repository root and is
included when packaging the CLI.

See [AGENTS.md](AGENTS.md) for architecture and testing rules, and the
[brand guidelines](docs/brand.md) for product copy and visuals.

## Continuous integration

| Job | Runtime | Validation |
| --- | --- | --- |
| Ubuntu 24.04 | Node 22.13.0 | CLI lint, typecheck, tests, build, and Bash/Zsh/Fish integration |
| macOS | Node 24 | CLI lint, typecheck, tests, and build |
| Minimum Git on Ubuntu 24.04 | Node 22.13.0, Git 2.31.0 | Git integration tests |
| Linux x64 binary on `main` | Bun from `.bun-version` | Build, version check, and standalone smoke test |
| Release preview and version tags | Bun from `.bun-version` | Four native builds, integration and PTY tests, installer verification, and archives |
| Docs on Ubuntu 24.04 | Node 24 | Static export for GitHub Pages |

Run `pnpm test:git` for CLI integration and
worktree-transfer tests. Use the `.integration.test.ts` suffix for new Git integration
coverage so the minimum-Git job includes it. See [Binary packaging](docs/binary-packaging.md)
for standalone test requirements and how to prepare a release draft.

## Work on the docs

Edit the canonical Markdown and MDX in [docs/](docs/) and run `pnpm docs:dev`. The local
site uses the same `/wald-worktree/` prefix as GitHub Pages.

See [the docs app guide](apps/docs/README.md) for demo recording and deployment.
