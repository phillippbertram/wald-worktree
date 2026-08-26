# Contributing

Thanks for helping improve `wt`.

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
or secrets as fixtures.
