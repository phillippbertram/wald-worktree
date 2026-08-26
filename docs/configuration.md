# Configuration

`wt` has one local configuration and one optional project configuration. Both are strict,
versioned YAML documents; unknown fields are errors.

## Local workspace configuration

Dedicated workspaces store `.wt/workspace.yaml`. Adopted repositories store
`<git-common-dir>/wt/workspace.yaml` and expose it through a `.wt` link in the worktree container.
This file is local and should not be committed.

```yaml
version: 1
mode: managed
paths:
  git: ../repo.git
  worktrees: ..
  primary_worktree: null
remote:
  name: origin
  fetch_refspec: +refs/heads/*:refs/remotes/origin/*
default_branch: main
trusted_project_config: null
```

All stored paths are relative to the configuration. `wt` canonicalizes them and enforces the
managed/adopted layout boundaries before using them.

## Project configuration

The repository-owned `.wt.yaml` supports this top-level schema:

```yaml
version: 1
defaults:
  fetch: true
  tool: code
hooks:
  pre_create: []
  post_create: []
  pre_remove: []
  post_remove: []
tasks: {}
tools: {}
```

Every section except `version` is optional and receives the defaults above.

### Command steps

Argument arrays are the default and do not invoke a shell:

```yaml
- type: command
  argv: [pnpm, install, --frozen-lockfile]
  cwd: target
  env:
    CI: "false"
  timeout_seconds: 600
  continue_on_error: false
```

Use `shell` only when shell syntax is intentional. It always executes as `/bin/sh -c` and cannot be
combined with `argv`:

```yaml
- type: command
  shell: pnpm build && cp dist/app "$WT_WORKTREE_PATH/.local/app"
```

`cwd` accepts `source`, `target`, or `workspace`. Its default is source for `pre_create`, workspace
for `post_remove`, and target otherwise. Commands receive:

- `WT_EVENT`: hook name or `task:<name>`
- `WT_WORKSPACE_ROOT`
- `WT_SOURCE_PATH`
- `WT_WORKTREE_PATH`
- `WT_BRANCH`

### File steps

`copy` and `symlink` are available in `post_create` and named tasks:

```yaml
- type: copy
  source: default
  from: .env.example
  to: .env
  optional: true
  overwrite: false

- type: symlink
  source: primary
  from: .local/cache
  to: .local/cache
```

`source` is `current`, `default`, or `primary`. Paths must be relative and stay inside their source
and target worktrees after resolving symlinks. Copy rejects symlinks inside the copied tree;
generated symlinks use relative targets.

### Lifecycle

Creation runs in this order:

```text
resolve branch/config -> trust -> pre_create -> git worktree add -> post_create
```

Removal runs:

```text
safety inspection -> trust -> pre_remove -> git worktree remove -> post_remove
```

`pre_create` failure leaves no new worktree. `post_create` failure keeps the worktree and reports
`wt setup <worktree>` for recovery. A `pre_remove` failure preserves the worktree.

### Named tasks and tool profiles

```yaml
tasks:
  verify:
    description: Run checks used before review
    steps:
      - type: command
        argv: [pnpm, lint]
      - type: command
        argv: [pnpm, test]

tools:
  app-agent:
    description: Start an agent with the app profile
    command: [codex, --profile, app]
    mode: foreground
```

Run these with `wt run verify [worktree]` and `wt open [worktree] --tool app-agent`. Tool arguments
may contain `{path}`; the selected worktree is also the process working directory. `mode` is
`foreground` or `detached`.

Built-in profiles are `code`, `cursor`, `zed`, `codex`, `codex-app`, and `claude`; unavailable
commands are omitted from interactive selection.

## Trust

Any non-empty hook, task, or custom tool makes `.wt.yaml` executable configuration. `wt` hashes the
validated, normalized behavior with SHA-256. This means comments, whitespace, and mapping order do
not change trust, while behavioral changes do.

```sh
wt config
wt config trust --yes
wt config untrust --yes
```

For a new managed workspace without a checkout, these commands inspect `.wt.yaml` directly from the
configured default branch.
