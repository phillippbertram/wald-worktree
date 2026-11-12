# Wald docs app

This pnpm package builds the Wald product page and Fumadocs site. The Markdown and MDX in
the root [docs directory](../../docs/) provide the docs content and remain readable on GitHub.
Edit `docs/meta.json` to change the sidebar order.

## Preview and verify

From the workspace root:

```sh
pnpm docs:dev
pnpm docs:check
pnpm --filter @wald/docs exec playwright install chromium
pnpm docs:test
```

Open `http://localhost:3000/wald-worktree/` for development. `docs:check` builds the CLI,
checks demo transcripts against current output, exports the site, and checks local links,
assets, and anchors. `docs:test` serves the static export for browser tests. It expects
a completed build in `apps/docs/out/`.

## Record a demo

```sh
pnpm docs:demos:record
```

The Python 3 recorder starts the built CLI in Unix PTYs. Each session uses a temporary home,
Git repository, and local remote. It captures ANSI output at a compact width and a wide
width. The cast files keep the real menus, output and colors. The recorder maps temporary
paths to `/demo` and adjusts the playback timing for chapter navigation.

When updating a demo, review both variants and the selected transcript in
`lib/demos.generated.json`. The browser player loads casts only when a visitor starts a demo
or selects a chapter.

The site uses WebP and JPEG exports of the canonical
[Wald illustration](../../docs/assets/wald-worktrees.png).

## Publish through GitHub Pages

In the repository’s **Settings → Pages**, choose **GitHub Actions** as the source. The
[Docs workflow](../../.github/workflows/docs.yml) builds on pull requests and uploads a
preview artifact. Pushes to `main` and manual runs from `main` deploy the verified export to
[the Wald site](https://phillippbertram.github.io/wald-worktree/). Check the deployment
environment URL and open a nested guide directly after the first release.

The search index is built alongside the pages. Search and terminal playback run in the
visitor’s browser.
